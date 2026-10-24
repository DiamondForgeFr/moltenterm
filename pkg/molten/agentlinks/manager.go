// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentlinks is wavesrv's registry of the MoltenTerm MCP servers' links (FR-CONT-022, DS-CONT-031): which
// server runs for which agent of which terminal, whether its link to MoltenTerm is up, and the developer's Reconnect
// and Stop from the terminal's connections menu. Each server holds a watch request (cmd/wsh's
// wshcmd-molten-mcpwatch.go); its route going down, its process and its agent's process tell the other states. A
// stopped link's calls are refused by the routes that serve them (Gate), so the stop holds whatever the agent does.
package agentlinks

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const (
	logPrefix = "molten agent links:"
	// A held watch never outlasts its server's own wait by much.
	maxHold = agentlinkwire.WatchHoldMs*time.Millisecond + 5*time.Second

	maxNameLen    = 60
	maxErrorLen   = 300
	maxVersionLen = 40

	errNotInMoltenTerm = "Not running in a MoltenTerm terminal"
	errNotUi           = "only a MoltenTerm window can change an agent's connections"
)

// LegacySession is a browser session opened by a server that does not report its link (started before #1050).
type LegacySession struct {
	Source     string
	ClientName string
	Started    time.Time
}

// Env is what the registry needs from wavesrv; tests replace it.
type Env interface {
	VerifyToken(token string) (string, error)
	Run(blockId string) (molten.AgentRunInfo, bool)
	Runs() []molten.AgentRunInfo
	// Alive: the process runs (an unknown answer counts as alive).
	Alive(pid int) bool
	Stops(blockId string) []string
	SetStops(blockId string, keys []string)
	Publish(state agentlinkwire.BlockLinks)
	Version() string
}

type link struct {
	blockId   string
	key       string
	report    agentlinkwire.WatchRequest
	source    string
	connected bool
	since     time.Time
	stopped   bool
	actions   chan string
}

type Manager struct {
	env  Env
	now  func() time.Time
	logf func(format string, args ...any)

	lock  sync.Mutex
	links map[string]*link
	// onStop: what other packages do when a link stops (the browser ends its sessions).
	onStop []func(source string)
	// legacy: the browser sessions of a terminal, for servers that do not report.
	legacy func(blockId string) []LegacySession
}

func MakeManager(env Env) *Manager {
	return &Manager{env: env, now: time.Now, logf: log.Printf, links: map[string]*link{}}
}

// LinkKey names a server within its terminal: the same across an in-place re-execution (#1049), which keeps the pid.
func LinkKey(server string, pid int) string {
	return fmt.Sprintf("%s:%d", server, pid)
}

func mapKey(blockId string, key string) string {
	return blockId + "/" + key
}

func validServer(server string) bool {
	return server == agentlinkwire.ServerBrowser || server == agentlinkwire.ServerReview
}

func cut(text string, n int) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(text))
	if len([]rune(text)) > n {
		return string([]rune(text)[:n])
	}
	return text
}

func cleanReport(req agentlinkwire.WatchRequest) agentlinkwire.WatchRequest {
	req.Token = ""
	req.HoldMs = 0
	req.ClientName = cut(req.ClientName, maxNameLen)
	req.ClientVersion = cut(req.ClientVersion, maxVersionLen)
	req.Version = cut(req.Version, maxVersionLen)
	req.LastError = cut(req.LastError, maxErrorLen)
	req.UpdateBlocked = cut(req.UpdateBlocked, maxErrorLen)
	if req.Failed < 0 {
		req.Failed = 0
	}
	if req.AgentPid < 0 {
		req.AgentPid = 0
	}
	return req
}

// verify: the token's terminal, which must be the one the caller's link was issued to.
func (m *Manager) verify(caller localroute.Caller, token string) (string, error) {
	if token == "" {
		return "", errors.New(errNotInMoltenTerm)
	}
	blockId, err := m.env.VerifyToken(token)
	if err != nil || blockId == "" {
		return "", errors.New(errNotInMoltenTerm)
	}
	if caller.BlockId != "" && caller.BlockId != blockId {
		return "", errors.New(errNotInMoltenTerm)
	}
	return blockId, nil
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// Watch records a server's report and holds the answer until an action or the hold's end.
func (m *Manager) Watch(ctx context.Context, caller localroute.Caller, req agentlinkwire.WatchRequest) (agentlinkwire.WatchResult, error) {
	blockId, err := m.verify(caller, req.Token)
	if err != nil {
		return agentlinkwire.WatchResult{}, err
	}
	if !validServer(req.Server) || req.Pid <= 0 {
		return agentlinkwire.WatchResult{}, fmt.Errorf("unknown MCP server %q (pid %d)", req.Server, req.Pid)
	}
	key := LinkKey(req.Server, req.Pid)
	stopped := contains(m.env.Stops(blockId), key)
	l, changed := m.upsert(blockId, key, caller.Source, cleanReport(req), stopped)
	if changed {
		m.publish(blockId)
	}
	if req.HoldMs <= 0 {
		return agentlinkwire.WatchResult{}, nil
	}
	hold := min(time.Duration(req.HoldMs)*time.Millisecond, maxHold)
	timer := time.NewTimer(hold)
	defer timer.Stop()
	select {
	case action := <-l.actions:
		return agentlinkwire.WatchResult{Action: action}, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	return agentlinkwire.WatchResult{}, nil
}

// upsert keeps the link's report; changed: something the menu shows moved.
func (m *Manager) upsert(blockId string, key string, source string, report agentlinkwire.WatchRequest, stopped bool) (*link, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	l := m.links[mapKey(blockId, key)]
	if l == nil {
		// The agent restarted this server (Claude Code's /mcp → Reconnect): its dead predecessor is no longer its link.
		for k, old := range m.links {
			if old.blockId == blockId && !old.connected && old.report.Server == report.Server && report.AgentPid > 0 &&
				old.report.AgentPid == report.AgentPid {
				delete(m.links, k)
			}
		}
		l = &link{blockId: blockId, key: key, stopped: stopped, since: m.now(), actions: make(chan string, 1)}
		m.links[mapKey(blockId, key)] = l
		l.report = report
		l.source = source
		l.connected = true
		return l, true
	}
	changed := !l.connected || l.source != source || l.report != report
	if !l.connected {
		l.since = m.now()
	}
	l.report = report
	l.source = source
	l.connected = true
	return l, changed
}

// RouteDown marks the links of a route that went down: their servers reconnect by themselves, or are gone.
func (m *Manager) RouteDown(route string) {
	if route == "" {
		return
	}
	for _, blockId := range m.markDown(route) {
		m.publish(blockId)
	}
}

func (m *Manager) markDown(route string) []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []string
	for _, l := range m.links {
		if l.source != route || !l.connected {
			continue
		}
		l.connected = false
		l.since = m.now()
		if !contains(rtn, l.blockId) {
			rtn = append(rtn, l.blockId)
		}
	}
	return rtn
}

// Bye forgets a server that ends with its agent's session.
func (m *Manager) Bye(caller localroute.Caller, req agentlinkwire.ByeRequest) error {
	blockId, err := m.verify(caller, req.Token)
	if err != nil {
		return err
	}
	key := LinkKey(req.Server, req.Pid)
	if !m.remove(blockId, key) {
		return nil
	}
	m.dropStop(blockId, key)
	m.publish(blockId)
	return nil
}

func (m *Manager) remove(blockId string, key string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.links[mapKey(blockId, key)] == nil {
		return false
	}
	delete(m.links, mapKey(blockId, key))
	return true
}

func (m *Manager) dropStop(blockId string, key string) {
	stops := m.env.Stops(blockId)
	if !contains(stops, key) {
		return
	}
	var rtn []string
	for _, s := range stops {
		if s != key {
			rtn = append(rtn, s)
		}
	}
	m.env.SetStops(blockId, rtn)
}

func (m *Manager) addStop(blockId string, key string) {
	stops := m.env.Stops(blockId)
	if contains(stops, key) {
		return
	}
	m.env.SetStops(blockId, append(append([]string{}, stops...), key))
}

// Gate refuses the calls of a stopped link; the routes serving the servers' calls ask it first.
func (m *Manager) Gate(source string) error {
	if source == "" {
		return nil
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	for _, l := range m.links {
		if l.source == source && l.stopped {
			return errors.New(agentlinkwire.ErrStopped)
		}
	}
	return nil
}

// OnStop runs fn with the route of each link the developer stops.
func (m *Manager) OnStop(fn func(source string)) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.onStop = append(m.onStop, fn)
}

// SetLegacySessions gives the registry the browser sessions of servers that do not report.
func (m *Manager) SetLegacySessions(fn func(blockId string) []LegacySession) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.legacy = fn
}

type controlTarget struct {
	source    string
	connected bool
	actions   chan string
	hooks     []func(source string)
}

// setStopped changes a link's stop; ok false: no such link.
func (m *Manager) setStopped(blockId string, key string, stopped bool) (controlTarget, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	l := m.links[mapKey(blockId, key)]
	if l == nil {
		return controlTarget{}, false
	}
	l.stopped = stopped
	return controlTarget{source: l.source, connected: l.connected, actions: l.actions, hooks: append([]func(string){}, m.onStop...)}, true
}

// Control is the developer's Reconnect or Stop from a window.
func (m *Manager) Control(caller localroute.Caller, req agentlinkwire.ControlRequest) error {
	if !caller.IsUi() {
		return errors.New(errNotUi)
	}
	switch req.Action {
	case agentlinkwire.ActionStop:
		target, ok := m.setStopped(req.BlockId, req.LinkKey, true)
		if !ok {
			return uimsg.Errorf(uimsg.Make("agentlinks.gone"), "This MCP server is no longer running")
		}
		m.addStop(req.BlockId, req.LinkKey)
		for _, hook := range target.hooks {
			hook(target.source)
		}
		m.logf("%s %s of %s stopped by the developer\n", logPrefix, req.LinkKey, req.BlockId)
	case agentlinkwire.ActionReconnect:
		target, ok := m.setStopped(req.BlockId, req.LinkKey, false)
		if !ok {
			return uimsg.Errorf(uimsg.Make("agentlinks.gone"), "This MCP server is no longer running")
		}
		m.dropStop(req.BlockId, req.LinkKey)
		if !target.connected {
			m.publish(req.BlockId)
			return uimsg.Errorf(uimsg.Make("agentlinks.unreachable"), "MoltenTerm cannot reach this MCP server now: restart it from the agent")
		}
		select {
		case target.actions <- agentlinkwire.ActionReconnect:
		default:
		}
		m.logf("%s %s of %s asked to reconnect\n", logPrefix, req.LinkKey, req.BlockId)
	default:
		return fmt.Errorf("unknown action %q", req.Action)
	}
	m.publish(req.BlockId)
	return nil
}

// State is the windows' read: one terminal, or every terminal with an agent or a link.
func (m *Manager) State(caller localroute.Caller, req agentlinkwire.StateRequest) ([]agentlinkwire.BlockLinks, error) {
	if !caller.IsUi() {
		return nil, errors.New(errNotUi)
	}
	if req.BlockId != "" {
		return []agentlinkwire.BlockLinks{m.Snapshot(req.BlockId)}, nil
	}
	var blocks []string
	for _, run := range m.env.Runs() {
		if run.Running && !contains(blocks, run.BlockId) {
			blocks = append(blocks, run.BlockId)
		}
	}
	for _, blockId := range m.linkBlocks() {
		if !contains(blocks, blockId) {
			blocks = append(blocks, blockId)
		}
	}
	sort.Strings(blocks)
	rtn := []agentlinkwire.BlockLinks{}
	for _, blockId := range blocks {
		rtn = append(rtn, m.Snapshot(blockId))
	}
	return rtn, nil
}

func (m *Manager) linkBlocks() []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []string
	for _, l := range m.links {
		if !contains(rtn, l.blockId) {
			rtn = append(rtn, l.blockId)
		}
	}
	return rtn
}

func (m *Manager) publish(blockId string) {
	m.env.Publish(m.Snapshot(blockId))
}

type linkCopy struct {
	key       string
	report    agentlinkwire.WatchRequest
	source    string
	connected bool
	since     time.Time
	stopped   bool
}

func (m *Manager) blockLinks(blockId string) ([]linkCopy, func(string) []LegacySession) {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []linkCopy
	for _, l := range m.links {
		if l.blockId == blockId {
			rtn = append(rtn, linkCopy{key: l.key, report: l.report, source: l.source, connected: l.connected, since: l.since, stopped: l.stopped})
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].key < rtn[j].key })
	return rtn, m.legacy
}

// PruneAll publishes the terminals with a down link again: a server whose process ended after its route went down
// is broken now, and an agent that quit took its links with it.
func (m *Manager) PruneAll() {
	for _, blockId := range m.downBlocks() {
		m.publish(blockId)
	}
}

func (m *Manager) downBlocks() []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []string
	for _, l := range m.links {
		if !l.connected && !contains(rtn, l.blockId) {
			rtn = append(rtn, l.blockId)
		}
	}
	return rtn
}

// prune forgets the links whose agent is gone: nothing uses them any more.
func (m *Manager) prune(blockId string, links []linkCopy) []linkCopy {
	var rtn []linkCopy
	for _, l := range links {
		if !l.connected && l.report.AgentPid > 0 && !m.env.Alive(l.report.AgentPid) {
			m.remove(blockId, l.key)
			m.dropStop(blockId, l.key)
			continue
		}
		rtn = append(rtn, l)
	}
	return rtn
}

func (m *Manager) linkInfo(l linkCopy, version string) agentlinkwire.LinkInfo {
	r := l.report
	info := agentlinkwire.LinkInfo{
		Key: l.key, Server: r.Server, Since: l.since.UnixMilli(), Pid: r.Pid, AgentPid: r.AgentPid,
		ClientName: r.ClientName, ClientVersion: r.ClientVersion, Version: r.Version,
		Outdated:      r.Version != "" && version != "" && r.Version != version,
		UpdatePending: r.UpdatePending, UpdateBlocked: r.UpdateBlocked,
		Failed: r.Failed, LastError: r.LastError, LastErrorAt: r.LastErrorAt,
		Controllable: l.connected,
	}
	switch {
	case l.stopped:
		info.State = agentlinkwire.StateStopped
	case l.connected:
		info.State = agentlinkwire.StateConnected
	case m.env.Alive(r.Pid):
		info.State = agentlinkwire.StateReconnecting
	default:
		info.State = agentlinkwire.StateBroken
	}
	return info
}

// MatchClientAgent finds the registry's agent an MCP client name names ("claude-code", "codex-mcp-client"), "" for
// one it does not know: the client's own name is shown then.
func MatchClientAgent(clientName string) string {
	name := strings.ToLower(clientName)
	for _, kind := range molten.AgentKinds {
		for _, cmd := range append([]string{kind.Id}, kind.Commands...) {
			if cmd != "" && strings.Contains(name, cmd) {
				return kind.Id
			}
		}
	}
	return ""
}

// Snapshot groups a terminal's links by the agent process that started them; the agent MoltenTerm detected in the
// pane is Main.
func (m *Manager) Snapshot(blockId string) agentlinkwire.BlockLinks {
	version := m.env.Version()
	rtn := agentlinkwire.BlockLinks{BlockId: blockId, Version: version, Agents: []agentlinkwire.AgentInfo{}}
	links, legacy := m.blockLinks(blockId)
	links = m.prune(blockId, links)
	run, hasRun := m.env.Run(blockId)
	hasRun = hasRun && run.Running
	type group struct {
		pid   int
		agent agentlinkwire.AgentInfo
	}
	var groups []*group
	find := func(pid int) *group {
		for _, g := range groups {
			if g.pid == pid {
				return g
			}
		}
		return nil
	}
	var main *group
	if hasRun {
		main = &group{pid: int(run.Pid), agent: agentlinkwire.AgentInfo{Main: true, Pid: int(run.Pid), Agent: run.Agent,
			AgentName: molten.AgentDisplayName(run.Agent), FirstName: run.FirstName, Model: run.Settings.ModelName,
			Links: []agentlinkwire.LinkInfo{}}}
		if main.agent.Model == "" {
			main.agent.Model = run.Settings.Model
		}
		groups = append(groups, main)
	}
	sources := map[string]bool{}
	for _, l := range links {
		sources[l.source] = true
		info := m.linkInfo(l, version)
		g := find(l.report.AgentPid)
		// A pane whose agent pid is unknown: its links are the detected agent's when the client names it.
		if g == nil && main != nil && main.pid == 0 && MatchClientAgent(l.report.ClientName) == run.Agent {
			g = main
		}
		if g == nil {
			agent := MatchClientAgent(l.report.ClientName)
			g = &group{pid: l.report.AgentPid, agent: agentlinkwire.AgentInfo{Pid: l.report.AgentPid, Agent: agent,
				AgentName: molten.AgentDisplayName(agent), ClientName: l.report.ClientName, Links: []agentlinkwire.LinkInfo{}}}
			if agent == "" {
				g.agent.AgentName = l.report.ClientName
			}
			groups = append(groups, g)
		}
		g.agent.Links = append(g.agent.Links, info)
	}
	if legacy != nil {
		for _, s := range legacy(blockId) {
			if sources[s.Source] {
				continue
			}
			info := agentlinkwire.LinkInfo{Key: "legacy:" + s.Source, Server: agentlinkwire.ServerBrowser,
				State: agentlinkwire.StateLegacy, Since: s.Started.UnixMilli(), ClientName: cut(s.ClientName, maxNameLen)}
			if main != nil {
				main.agent.Links = append(main.agent.Links, info)
				continue
			}
			groups = append(groups, &group{agent: agentlinkwire.AgentInfo{ClientName: info.ClientName, AgentName: info.ClientName,
				Links: []agentlinkwire.LinkInfo{info}}})
		}
	}
	for _, g := range groups {
		rtn.Agents = append(rtn.Agents, g.agent)
	}
	return rtn
}
