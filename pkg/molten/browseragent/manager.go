// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinks"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const (
	// A tab the panel has not saved yet (its Wave tab is not shown, or the panel is still mounting) counts as opening
	// for this long before it counts as closed.
	pendingTabGrace = 30 * time.Second
	openWaitTimeout = 3 * time.Second
	openPollEvery   = 100 * time.Millisecond
	liveReadTimeout = 1500 * time.Millisecond

	// A runaway agent cannot fill the panel.
	maxTabsPerSession = 20

	defaultAgentName = "An agent"
	maxAgentNameLen  = 40
	logPrefix        = "molten browser agent:"

	// How long a session whose link went down waits for its server to come back on a new link (#1541): a server
	// replacing its program in place (#1049) or reconnecting at the developer's request is back within milliseconds.
	defaultParkGrace = 10 * time.Second
)

type agentTab struct {
	id       int64
	key      TabKey
	origin   string
	state    string
	action   string
	actionTs int64
	cue      *ActionCue
	// viewport is the size the resize tool emulates, until control ends.
	viewport *Viewport
	// download is the latest download confirmation of the tab, which the call that started it waits for.
	download  *permissionRequest
	createdAt time.Time
	confirmed bool
	// engaged: the agent acts on the tab, so it shows the control bar and emain watches it. A tab the user shared
	// engages on the agent's first call on it (FR-BRW-011).
	engaged bool
	calls   map[int64]context.CancelFunc
	// refs maps read_page and find's element refs to the page's DOM nodes, for the document they were read from.
	refs *refTable
}

type session struct {
	id        string
	source    string
	blockId   string
	agentName string
	started   time.Time
	tabs      map[int64]*agentTab
	// allowedOnce holds the sites the user allowed for this session only (Allow once).
	allowedOnce map[string]bool
	// notices are what the user did with the session's tabs (a share, a give back), told to the agent in its next tool
	// result (#971): an agent never asked would not know a tab is its to use.
	notices []tabNotice
	// pid: the server's process as its link reports it, the same across a re-execution; 0 when it does not report.
	pid int
	// parked: its link went down and its server may come back on a new one (#1541); parkGen tells the parks apart.
	parked  bool
	parkGen int
}

type tabNotice struct {
	tabId int64
	// note is what tabs_context shows on the tab until the agent has been told.
	note string
	text string
}

// sessionInfo is a copy of a session's identity, read outside the lock.
type sessionInfo struct {
	id        string
	blockId   string
	agentName string
}

// tabInfo is a copy of an agent tab, read outside the lock.
type tabInfo struct {
	id        int64
	key       TabKey
	origin    string
	state     string
	createdAt time.Time
	confirmed bool
	engaged   bool
}

type Manager struct {
	env  Env
	now  func() time.Time
	logf func(format string, args ...any)

	permissionTimeout time.Duration
	permissionPoll    time.Duration
	parkGrace         time.Duration

	lock       sync.Mutex
	sessions   map[string]*session
	owners     map[TabKey]string
	nextTabId  int64
	nextCallId int64
	requests   map[string]*permissionRequest
	recent     map[string]recentDecision
}

func MakeManager(env Env) *Manager {
	return &Manager{
		env:      env,
		now:      time.Now,
		logf:     log.Printf,
		sessions: make(map[string]*session),
		owners:   make(map[TabKey]string),
		requests: make(map[string]*permissionRequest),
		recent:   make(map[string]recentDecision),

		permissionTimeout: defaultPermissionTimeout,
		permissionPoll:    defaultPermissionPoll,
		parkGrace:         defaultParkGrace,
	}
}

// cleanAgentName keeps a name fit for the bar: one line, printable, short.
func cleanAgentName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if len([]rune(name)) > maxAgentNameLen {
		name = string([]rune(name)[:maxAgentNameLen])
	}
	return name
}

// agentDisplayName: the agent MoltenTerm detected in the pane, else the name the MCP client gave.
func agentDisplayName(detected string, clientName string) string {
	if name := cleanAgentName(detected); name != "" {
		return name
	}
	if name := cleanAgentName(clientName); name != "" {
		return name
	}
	return defaultAgentName
}

// Hello opens a session for the pane the token was issued to. source is the router-stamped route of the caller: the
// session's calls must come from it.
func (m *Manager) Hello(ctx context.Context, source string, req mcpbrowser.HelloRequest) (mcpbrowser.HelloResult, error) {
	if source == "" || req.Token == "" {
		return mcpbrowser.HelloResult{}, errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	blockId, err := m.env.VerifyToken(req.Token)
	if err != nil || blockId == "" {
		return mcpbrowser.HelloResult{}, errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	if err := m.checkPane(ctx, blockId); err != nil {
		return mcpbrowser.HelloResult{}, err
	}
	s := m.openSession(source, blockId, req.ClientName, "started")
	return mcpbrowser.HelloResult{SessionId: s.id, AgentName: s.agentName}, nil
}

// checkPane: a session is for a local terminal only.
func (m *Manager) checkPane(ctx context.Context, blockId string) error {
	loc, err := m.env.LocateBlock(ctx, blockId)
	if err != nil || loc.View != TermView {
		return errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	if !loc.Local {
		return errors.New(mcpbrowser.ErrRemotePane)
	}
	return nil
}

// LinkReported makes sure a running molten-browser link has its session (#1541). The link registry says the server is
// connected as soon as its link is back (wavesrv restarted, the developer's Reconnect, a re-execution), while the
// server opens a session only at the agent's next browser call: without this, the terminal's connections showed it
// connected and Share with agent said it had lost the browser. The server's next hello, on the same link, takes this
// session over. The same server process (pid) back on a new link takes its earlier session back, with its tabs.
func (m *Manager) LinkReported(ctx context.Context, blockId string, source string, server string, pid int, clientName string) {
	if server != agentlinkwire.ServerBrowser || source == "" || blockId == "" {
		return
	}
	if moved, ok := m.adoptSession(source, blockId, pid); ok {
		if moved != nil {
			m.logf("%s session=%s agent=%q back on a new link\n", logPrefix, shortId(moved.id), moved.agentName)
		}
		return
	}
	if m.checkPane(ctx, blockId) != nil {
		return
	}
	s := m.openSession(source, blockId, clientName, "opened for its link")
	m.setSessionPid(s.id, pid)
}

// linkReport is LinkReported as the link registry calls it.
func (m *Manager) linkReport(ctx context.Context, blockId string, source string, report agentlinkwire.WatchRequest) {
	m.LinkReported(ctx, blockId, source, report.Server, report.Pid, report.ClientName)
}

// adoptSession finds the link's session: the one on its route (ok, nothing moved), or the one the same server process
// had on its previous link (moved to this route). The previous route's down event may come after the new report.
func (m *Manager) adoptSession(source string, blockId string, pid int) (*sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s := m.sessionOnLocked(source, blockId); s != nil {
		if s.pid <= 0 {
			s.pid = pid
		}
		return nil, true
	}
	if pid <= 0 {
		return nil, false
	}
	var prev *session
	for _, s := range m.sessions {
		if s.blockId == blockId && s.pid == pid && (prev == nil || s.started.After(prev.started)) {
			prev = s
		}
	}
	if prev == nil {
		return nil, false
	}
	prev.source = source
	prev.parked = false
	return &sessionInfo{id: prev.id, blockId: prev.blockId, agentName: prev.agentName}, true
}

func (m *Manager) setSessionPid(sessionId string, pid int) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s := m.sessions[sessionId]; s != nil && s.pid <= 0 {
		s.pid = pid
	}
}

func (m *Manager) sessionOnLocked(source string, blockId string) *session {
	for _, s := range m.sessions {
		if s.source == source && s.blockId == blockId {
			return s
		}
	}
	return nil
}

// openSession returns the session of the link (one per route: a route is one connection of one server), opening it
// when there is none. Sessions of the pane's other routes stay until their route goes.
func (m *Manager) openSession(source string, blockId string, clientName string, how string) sessionInfo {
	name := agentDisplayName(m.env.AgentName(blockId), clientName)
	info, opened := m.openSessionLocked(source, blockId, name)
	if opened {
		m.logf("%s session=%s agent=%q %s\n", logPrefix, shortId(info.id), info.agentName, how)
	}
	return info
}

func (m *Manager) openSessionLocked(source string, blockId string, name string) (sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s := m.sessionOnLocked(source, blockId); s != nil {
		s.agentName = name
		return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, false
	}
	s := &session{
		id:          uuid.NewString(),
		source:      source,
		blockId:     blockId,
		agentName:   name,
		started:     m.now(),
		tabs:        make(map[int64]*agentTab),
		allowedOnce: make(map[string]bool),
	}
	m.sessions[s.id] = s
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

func shortId(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func (m *Manager) sessionFor(sessionId string, source string) (sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil || s.source != source {
		return sessionInfo{}, false
	}
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

// Bye ends the session the MCP server opened (stdin closed: the agent quit).
func (m *Manager) Bye(source string, sessionId string) {
	m.endSessions(func(s *session) bool { return s.id == sessionId && s.source == source }, "ended")
}

// EndSessionsForRoute ends the sessions of a route that went down (the server was killed without a bye).
func (m *Manager) EndSessionsForRoute(route string) {
	if route == "" {
		return
	}
	// A reporting server's session keeps its tabs a moment, for the server's next link to take it back: the
	// developer's Reconnect and a re-execution (#1049) end a link, not the agent's work, nor a page just shared.
	for _, park := range m.parkSessions(route) {
		m.logf("%s session=%s agent=%q parked\n", logPrefix, shortId(park.id), park.agentName)
		time.AfterFunc(m.parkGrace, func() {
			m.endSessions(func(s *session) bool { return s.id == park.id && s.parked && s.parkGen == park.gen }, "disconnected")
		})
	}
	m.endSessions(func(s *session) bool { return s.source == route && !s.parked }, "disconnected")
}

type parkedSession struct {
	id        string
	agentName string
	gen       int
}

func (m *Manager) parkSessions(route string) []parkedSession {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []parkedSession
	for _, s := range m.sessions {
		if s.source != route || s.pid <= 0 || s.parked {
			continue
		}
		s.parked = true
		s.parkGen++
		rtn = append(rtn, parkedSession{id: s.id, agentName: s.agentName, gen: s.parkGen})
	}
	return rtn
}

// endSessions removes matching sessions: their tabs stay open as user tabs, their bars go (FR-BRW-008 AC9).
func (m *Manager) endSessions(match func(s *session) bool, reason string) {
	keys, ended := m.removeSessions(match)
	for _, key := range keys {
		m.env.SetControl(key, false)
	}
	for _, panelId := range panelsOf(keys) {
		m.publishPanel(panelId)
	}
	for _, s := range ended {
		m.logf("%s session=%s agent=%q %s\n", logPrefix, shortId(s.id), s.agentName, reason)
	}
}

func (m *Manager) removeSessions(match func(s *session) bool) ([]TabKey, []sessionInfo) {
	m.lock.Lock()
	defer m.lock.Unlock()
	var keys []TabKey
	var ended []sessionInfo
	for id, s := range m.sessions {
		if !match(s) {
			continue
		}
		m.endRequestsLocked(s.id, 0)
		for _, t := range s.tabs {
			cancelCallsLocked(t)
			if m.owners[t.key] == s.id {
				delete(m.owners, t.key)
				keys = append(keys, t.key)
			}
		}
		delete(m.sessions, id)
		ended = append(ended, sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName})
	}
	return keys, ended
}

func panelsOf(keys []TabKey) []string {
	seen := make(map[string]bool)
	var rtn []string
	for _, k := range keys {
		if !seen[k.PanelId] {
			seen[k.PanelId] = true
			rtn = append(rtn, k.PanelId)
		}
	}
	sort.Strings(rtn)
	return rtn
}

func cancelCallsLocked(t *agentTab) {
	for id, cancel := range t.calls {
		cancel()
		delete(t.calls, id)
	}
}

// isUiSource: control and panel state come from a MoltenTerm window or emain, never from a terminal (an agent cannot
// give itself control back). The router stamps a leaf's source with its own route.
func isUiSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab) || source == wshutil.ElectronRoute
}

// Control applies Stop, Take over or Give back to a tab (DS-BRW-011), each an explicit act of the user in the panel
// (#971). Stop and takeover cancel the calls in flight on
// the tab before returning; Stop also releases the tab, which stays open as a user tab.
func (m *Manager) Control(source string, req ControlRequest) error {
	if !isUiSource(source) {
		return errors.New("only a MoltenTerm window can stop an agent or hand a tab back")
	}
	if req.Action != ControlStop && req.Action != ControlTakeOver && req.Action != ControlGiveBack {
		return fmt.Errorf("unknown control action %q", req.Action)
	}
	key := TabKey{PanelId: req.BlockId, BrowserTabId: req.BrowserTabId}
	changed, info, released := m.applyControl(key, req.Action)
	if !changed {
		return nil
	}
	if released || req.Action == ControlTakeOver {
		// After Take over the page is the user's: emain stops holding back their clicks and keys (#971).
		m.env.SetControl(key, false)
	}
	m.publishPanel(key.PanelId)
	if req.Action == ControlGiveBack {
		// emain paused the tab on the user's input; control comes back with the bar.
		m.env.SetControl(key, true)
	}
	m.logf("%s session=%s agent=%q control=%s\n", logPrefix, shortId(info.id), info.agentName, req.Action)
	return nil
}

func (m *Manager) applyControl(key TabKey, action string) (bool, sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[m.owners[key]]
	if s == nil {
		return false, sessionInfo{}, false
	}
	t := s.tabFor(key)
	if t == nil {
		return false, sessionInfo{}, false
	}
	info := sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}
	switch action {
	case ControlStop:
		cancelCallsLocked(t)
		m.endRequestsLocked(s.id, t.id)
		t.state = TabStateStopped
		t.viewport = nil
		delete(m.owners, key)
		return true, info, true
	case ControlTakeOver:
		if t.state != TabStateActive {
			return false, info, false
		}
		cancelCallsLocked(t)
		t.state = TabStateTakenOver
		// emain clears the emulated viewport when control ends.
		t.viewport = nil
		return true, info, false
	case ControlGiveBack:
		if t.state != TabStateTakenOver {
			return false, info, false
		}
		t.state = TabStateActive
		s.addNotice(t.id, noteGivenBack, givenBackNotice(t.id))
		return true, info, false
	}
	return false, info, false
}

func (s *session) tabFor(key TabKey) *agentTab {
	for _, t := range s.tabs {
		if t.key == key {
			return t
		}
	}
	return nil
}

// PanelSnapshot is the state a panel shows when it mounts; events keep it current.
func (m *Manager) PanelSnapshot(source string, panelId string) (PanelState, error) {
	if !isUiSource(source) {
		return PanelState{}, errors.New("only a MoltenTerm window can read the agent state of a panel")
	}
	return m.panelState(panelId), nil
}

func (m *Manager) panelState(panelId string) PanelState {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := PanelState{BlockId: panelId, Tabs: []PanelAgentTab{}}
	for key, sessionId := range m.owners {
		if key.PanelId != panelId {
			continue
		}
		s := m.sessions[sessionId]
		if s == nil {
			continue
		}
		t := s.tabFor(key)
		if t == nil {
			continue
		}
		rtn.Tabs = append(rtn.Tabs, PanelAgentTab{
			BrowserTabId: key.BrowserTabId,
			AgentName:    s.agentName,
			AgentBlockId: s.blockId,
			Origin:       t.origin,
			State:        t.state,
			Action:       t.action,
			ActionText:   actionText(t.action),
			ActionTs:     t.actionTs,
			Cue:          t.cue,
			Permission:   m.pendingPromptLocked(key),
			Viewport:     t.viewport,
			Engaged:      t.engaged,
			Since:        t.createdAt.UnixMilli(),
		})
	}
	sort.Slice(rtn.Tabs, func(i, j int) bool { return rtn.Tabs[i].BrowserTabId < rtn.Tabs[j].BrowserTabId })
	return rtn
}

func (m *Manager) publishPanel(panelId string) {
	if panelId == "" {
		return
	}
	m.env.Publish(m.panelState(panelId))
}

// openTabCount counts the tabs a session holds (stopped ones are the user's).
func (m *Manager) openTabCount(sessionId string) int {
	return len(m.listTabs(sessionId))
}

// addTab registers a tab for the session and returns its agent-facing id; 0 when the session ended meanwhile, holds
// too many tabs, or the tab already belongs to another session (a tab has one owner at a time).
func (m *Manager) addTab(sessionId string, key TabKey, origin string, action string) int64 {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return 0
	}
	open := 0
	for _, t := range s.tabs {
		if t.state != TabStateStopped {
			open++
		}
	}
	if open >= maxTabsPerSession {
		return 0
	}
	if owner, taken := m.owners[key]; taken && owner != sessionId {
		return 0
	}
	m.nextTabId++
	now := m.now()
	s.tabs[m.nextTabId] = &agentTab{
		id:        m.nextTabId,
		key:       key,
		origin:    origin,
		state:     TabStateActive,
		action:    action,
		actionTs:  now.UnixMilli(),
		createdAt: now,
		confirmed: origin == OriginShared,
		engaged:   origin == OriginOpened,
		calls:     make(map[int64]context.CancelFunc),
	}
	m.owners[key] = sessionId
	return m.nextTabId
}

func (m *Manager) tab(sessionId string, tabId int64) (tabInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return tabInfo{}, false
	}
	t := s.tabs[tabId]
	if t == nil {
		return tabInfo{}, false
	}
	return t.info(), true
}

// listTabs returns the session's tabs the agent can still see (stopped ones are the user's again), by id.
func (m *Manager) listTabs(sessionId string) []tabInfo {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return nil
	}
	var rtn []tabInfo
	for _, t := range s.tabs {
		if t.state == TabStateStopped {
			continue
		}
		rtn = append(rtn, t.info())
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].id < rtn[j].id })
	return rtn
}

func (t *agentTab) info() tabInfo {
	return tabInfo{id: t.id, key: t.key, origin: t.origin, state: t.state, createdAt: t.createdAt, confirmed: t.confirmed, engaged: t.engaged}
}

func (m *Manager) confirmTab(sessionId string, tabId int64) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if t := m.sessions[sessionId].tabOrNil(tabId); t != nil {
		t.confirmed = true
	}
}

func (s *session) tabOrNil(tabId int64) *agentTab {
	if s == nil {
		return nil
	}
	return s.tabs[tabId]
}

// dropTab forgets a tab that is closed or gone; it releases the tab if the session still owned it. A tab that never
// opened (its panel was not shown) is closed too, so it cannot appear later with no agent and no bar.
func (m *Manager) dropTab(sessionId string, tabId int64) {
	info, _ := m.tab(sessionId, tabId)
	key, released := m.removeTab(sessionId, tabId)
	if key.PanelId == "" {
		return
	}
	if !info.confirmed {
		m.env.CloseTab(context.Background(), key)
	}
	if released {
		m.env.SetControl(key, false)
	}
	m.publishPanel(key.PanelId)
}

func (m *Manager) removeTab(sessionId string, tabId int64) (TabKey, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	t := s.tabOrNil(tabId)
	if t == nil {
		return TabKey{}, false
	}
	cancelCallsLocked(t)
	m.endRequestsLocked(sessionId, tabId)
	delete(s.tabs, tabId)
	if m.owners[t.key] != sessionId {
		return t.key, false
	}
	delete(m.owners, t.key)
	return t.key, true
}

// stateError is the fixed sentence for a tab the agent may not act on now, "" when it may.
func stateError(state string) string {
	switch state {
	case TabStateStopped:
		return mcpbrowser.ErrStopped
	case TabStateTakenOver:
		return mcpbrowser.ErrTakenOver
	}
	return ""
}

// beginTabCall registers a call acting on a tab, so Stop and takeover can cancel it; it refuses a tab the agent may
// not act on.
func (m *Manager) beginTabCall(sessionId string, tabId int64, cancel context.CancelFunc) (int64, string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.sessions[sessionId].tabOrNil(tabId)
	if t == nil {
		return 0, mcpbrowser.ErrNotYourTab
	}
	if errText := stateError(t.state); errText != "" {
		return 0, errText
	}
	m.nextCallId++
	t.calls[m.nextCallId] = cancel
	return m.nextCallId, ""
}

func (m *Manager) endTabCall(sessionId string, tabId int64, callId int64) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if t := m.sessions[sessionId].tabOrNil(tabId); t != nil {
		delete(t.calls, callId)
	}
}

func (m *Manager) tabStateError(sessionId string, tabId int64) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return mcpbrowser.ErrSessionEnded
	}
	t := s.tabs[tabId]
	if t == nil {
		return mcpbrowser.ErrTabClosed
	}
	return stateError(t.state)
}

// runOnTab runs fn with a context that Stop or takeover of the tab cancels; it returns the fixed sentence of the
// refusal or cancellation, "" on success, and fn's error otherwise.
func (m *Manager) runOnTab(ctx context.Context, sessionId string, tabId int64, fn func(ctx context.Context) error) (string, error) {
	tabCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	callId, errText := m.beginTabCall(sessionId, tabId, cancel)
	if errText != "" {
		return errText, nil
	}
	defer m.endTabCall(sessionId, tabId, callId)
	err := fn(tabCtx)
	if tabCtx.Err() != nil && ctx.Err() == nil {
		if errText := m.tabStateError(sessionId, tabId); errText != "" {
			return errText, nil
		}
	}
	return "", err
}

// noteAction shows what the agent does on a tab in its control bar (NFR-BRW-007): fixed words, a host, a key name or
// an element's short label, never typed text or a field's value.
func (m *Manager) noteAction(sessionId string, tabId int64, action string) {
	m.noteActionAt(sessionId, tabId, action, nil)
}

// noteActionAt also draws where the action happens (DS-BRW-011).
func (m *Manager) noteActionAt(sessionId string, tabId int64, action string, cue *ActionCue) {
	panelId := m.setAction(sessionId, tabId, action, cue)
	m.publishPanel(panelId)
}

func (m *Manager) setAction(sessionId string, tabId int64, action string, cue *ActionCue) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.sessions[sessionId].tabOrNil(tabId)
	if t == nil {
		return ""
	}
	t.action = action
	t.actionTs = m.now().UnixMilli()
	t.cue = cue
	return t.key.PanelId
}

func (m *Manager) setViewport(sessionId string, tabId int64, viewport *Viewport) {
	panelId := m.storeViewport(sessionId, tabId, viewport)
	m.publishPanel(panelId)
}

func (m *Manager) storeViewport(sessionId string, tabId int64, viewport *Viewport) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.sessions[sessionId].tabOrNil(tabId)
	if t == nil {
		return ""
	}
	t.viewport = viewport
	return t.key.PanelId
}

// legacySessions lists a terminal's sessions for the connections menu (FR-CONT-022): the registry shows those whose
// server does not report its link.
func (m *Manager) legacySessions(blockId string) []agentlinks.LegacySession {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []agentlinks.LegacySession
	for _, s := range m.sessions {
		if s.blockId == blockId && !s.parked {
			rtn = append(rtn, agentlinks.LegacySession{Source: s.source, ClientName: s.agentName, Started: s.started})
		}
	}
	return rtn
}
