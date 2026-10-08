// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The windows, Electron main and the shims reach the keeper through a leaf of wavesrv's router answering plain command
// names, like the agent states (attention/agentroute.go): nothing is declared in pkg/wshrpc.
//
// Trust: any wsh client can publish an event under any name, so the molten:keepawake event is only a signal; the
// state is read back from this route, which answers MoltenTerm's windows and Electron main only. The coffee and the
// overrides are changed from a window; the shims report from a local terminal's own link, never through a remote
// connection's router link.

const (
	routeQueueSize = 64
	// The rules are applied this often while there is something to follow, and at once on an agent state, a shell
	// mark, a block's close, a workspace change or a new setting; the windows show the grace to the second.
	tickInterval  = 2 * time.Second
	pokeDebounce  = 200 * time.Millisecond
	storeTimeout  = 3 * time.Second
	locateTimeout = 2 * time.Second
	// Where a block is changes rarely (a pane moved to another tab): looked up again after this.
	locateCacheTtl = 30 * time.Second
	// A block that could not be found is not looked up again before this.
	locateMissTtl = 5 * time.Second
	// A workspace's name and existence, read for each coffee, are cached this long (a workspace change clears them).
	workspaceCacheTtl = 10 * time.Second
)

// Hooks are what other parts of wavesrv give the keeper; pkg/blockcontroller wires them (moltenterm_keepawake.go).
type Hooks struct {
	// CommandBlocks: the cmd blocks whose command runs now.
	CommandBlocks func() []string
	// ShellRunning: the block's shell process still runs.
	ShellRunning func(blockId string) bool
	// MissionWorkspaces: the workspaces whose linked project has a Mission Control run going.
	MissionWorkspaces func(ctx context.Context) []string
}

type service struct {
	keeper     *Keeper
	commands   *commandTracker
	locate     *ttlCache[BlockInfo]
	workspaces *ttlCache[workspaceEntry]
	poke       chan struct{}
}

type workspaceEntry struct {
	name   string
	exists bool
}

type ttlEntry[T any] struct {
	value   T
	found   bool
	expires time.Time
}

// ttlCache keeps lookups for a while, misses included (shorter), and drops expired entries on sweep.
type ttlCache[T any] struct {
	lock    sync.Mutex
	entries map[string]ttlEntry[T]
}

func makeTtlCache[T any]() *ttlCache[T] {
	return &ttlCache[T]{entries: map[string]ttlEntry[T]{}}
}

// get returns the value, whether it was found, and whether the cache knew.
func (c *ttlCache[T]) get(key string, now time.Time) (T, bool, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[key]
	if !ok || now.After(e.expires) {
		var zero T
		return zero, false, false
	}
	return e.value, e.found, true
}

func (c *ttlCache[T]) put(key string, value T, found bool, expires time.Time) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.entries[key] = ttlEntry[T]{value: value, found: found, expires: expires}
}

func (c *ttlCache[T]) forget(key string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	delete(c.entries, key)
}

func (c *ttlCache[T]) clear() {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.entries = map[string]ttlEntry[T]{}
}

func (c *ttlCache[T]) sweep(now time.Time) {
	c.lock.Lock()
	defer c.lock.Unlock()
	for key, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, key)
		}
	}
}

func isLocalConn(conn string) bool {
	return conn == "" || conn == "local" || strings.HasPrefix(conn, "local:") || strings.HasPrefix(conn, "wsl://")
}

func (s *service) locateBlock(ctx context.Context, blockId string) (BlockInfo, bool) {
	now := time.Now()
	if info, found, known := s.locate.get(blockId, now); known {
		return info, found
	}
	info, found := readBlockInfo(ctx, blockId)
	if !found {
		s.locate.put(blockId, BlockInfo{}, false, now.Add(locateMissTtl))
		return BlockInfo{}, false
	}
	s.locate.put(blockId, info, true, now.Add(locateCacheTtl))
	return info, true
}

func readBlockInfo(ctx context.Context, blockId string) (BlockInfo, bool) {
	ctx, cancel := context.WithTimeout(ctx, locateTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return BlockInfo{}, false
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return BlockInfo{}, false
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return BlockInfo{}, false
	}
	return BlockInfo{
		WorkspaceId: wsId,
		Remote:      !isLocalConn(block.Meta.GetString(waveobj.MetaKey_Connection, "")),
		Cmd:         block.Meta.GetString(waveobj.MetaKey_Cmd, ""),
	}, true
}

func (s *service) workspaceName(ctx context.Context, wsId string) (string, bool) {
	now := time.Now()
	if e, _, known := s.workspaces.get(wsId, now); known {
		return e.name, e.exists
	}
	ctx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		// Unknown is not deleted: the coffee stays, and the next pass asks again.
		return "", true
	}
	entry := workspaceEntry{exists: ws != nil}
	if ws != nil {
		entry.name = ws.Name
	}
	s.workspaces.put(wsId, entry, true, now.Add(workspaceCacheTtl))
	return entry.name, entry.exists
}

func (s *service) locateNames(ctx context.Context, blockId string) (string, string, string) {
	ctx, cancel := context.WithTimeout(ctx, locateTimeout)
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return "", "", ""
	}
	tabName := ""
	if tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId); err == nil && tab != nil {
		tabName = tab.Name
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return "", "", tabName
	}
	name, _ := s.workspaceName(ctx, wsId)
	return wsId, name, tabName
}

func processAlive(pid int32) bool {
	if pid <= 0 {
		return false
	}
	alive, err := goproc.PidExists(pid)
	return err != nil || alive
}

func processName(pid int32) string {
	p, err := goproc.NewProcess(pid)
	if err != nil {
		return ""
	}
	name, err := p.Name()
	if err != nil {
		return ""
	}
	return name
}

func currentPolicy() string {
	return wconfig.GetWatcher().GetFullConfig().Settings.PowerSleepPolicy
}

// eventSignal is all the event carries: readers ask the route for the state.
type eventSignal struct {
	Version int64 `json:"version"`
}

func publishState(state State) {
	wps.Broker.Publish(wps.WaveEvent{Event: Event, Data: eventSignal{Version: state.Version}})
}

func notify(input molten.NotificationInput) {
	goSafe("molten:keepawake:notify", func() {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		defer cancel()
		if err := attention.PublishNotification(ctx, input); err != nil {
			log.Printf("molten: keep-awake notification: %v\n", err)
		}
	})
}

func goSafe(name string, fn func()) {
	go func() {
		defer func() {
			panichandler.PanicHandler(name, recover())
		}()
		fn()
	}()
}

func makeService(hooks Hooks) *service {
	s := &service{
		commands:   makeCommandTracker(),
		locate:     makeTtlCache[BlockInfo](),
		workspaces: makeTtlCache[workspaceEntry](),
		poke:       make(chan struct{}, 1),
	}
	sources := WorkSources{
		Agents:            attention.AgentRuns,
		Commands:          s.commands.snapshot,
		CommandBlocks:     hooks.CommandBlocks,
		ShellRunning:      hooks.ShellRunning,
		Locate:            s.locateBlock,
		MissionWorkspaces: hooks.MissionWorkspaces,
	}
	s.keeper = MakeKeeper(Env{
		Now:          time.Now,
		Policy:       currentPolicy,
		Work:         func(ctx context.Context) Work { return ComputeWork(ctx, sources) },
		Workspace:    s.workspaceName,
		LocateNames:  s.locateNames,
		Notify:       notify,
		Publish:      publishState,
		ProcessAlive: processAlive,
		ProcessName:  processName,
		Async:        func(fn func()) { goSafe("molten:keepawake:shim", fn) },
	})
	return s
}

func (s *service) trigger() {
	select {
	case s.poke <- struct{}{}:
	default:
	}
}

// triggerIfActive: what runs in the terminals matters only while something follows it.
func (s *service) triggerIfActive() {
	if s.keeper.Active() {
		s.trigger()
	}
}

func (s *service) loop() {
	defer func() {
		panichandler.PanicHandler("molten:keepawake:loop", recover())
	}()
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !s.keeper.Active() {
				continue
			}
		case <-s.poke:
			time.Sleep(pokeDebounce)
		}
		now := time.Now()
		s.locate.sweep(now)
		s.workspaces.sweep(now)
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		s.keeper.Evaluate(ctx)
		cancel()
	}
}

func (s *service) observeMark(blockId string, mark attention.ShellMark) {
	switch mark.Kind {
	case attention.ShellMarkCommand, attention.ShellMarkDone, attention.ShellMarkPrompt:
		s.commands.observe(blockId, mark.Kind, mark.Cmd)
		s.triggerIfActive()
	}
}

func (s *service) blockClosed(event *wps.WaveEvent) {
	blockId, ok := event.Data.(string)
	if !ok || blockId == "" {
		return
	}
	s.commands.forget(blockId)
	s.locate.forget(blockId)
	s.keeper.ForgetBlock(blockId)
	s.triggerIfActive()
}

type routeLink struct {
	s      *service
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return Route
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	// The router calls this under its own lock: who asks is read in the answer's goroutine (IsLeafSource takes it).
	go l.answer(req, ingressLinkId)
	return true
}

const (
	fromOther    = ""
	fromWindow   = "window"
	fromElectron = "electron"
	fromTerminal = "terminal"
)

// sourceKind reads who asks from the link a request came in through: a window or Electron main when its source is a
// route bound to that very link (their websocket), a local terminal when the source is the one the router stamped on
// the terminal's own leaf link. Anything else (a remote connection's router link, a forged source) is other.
func sourceKind(source string, ingressLinkId baseds.LinkId) string {
	router := wshutil.DefaultRouter
	switch {
	case strings.HasPrefix(source, wshutil.RoutePrefix_Tab) && router.IsSourceOnLink(ingressLinkId, source):
		return fromWindow
	case source == wshutil.ElectronRoute && router.IsSourceOnLink(ingressLinkId, source):
		return fromElectron
	case strings.HasPrefix(source, wshutil.RoutePrefix_Proc) && router.IsLeafSource(ingressLinkId, source):
		return fromTerminal
	}
	return fromOther
}

func (l *routeLink) answer(req wshutil.RpcMessage, ingressLinkId baseds.LinkId) {
	defer func() {
		panichandler.PanicHandler("molten:keepawake:route", recover())
	}()
	from := sourceKind(req.Source, ingressLinkId)
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, from, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

func (l *routeLink) handle(command string, from string, data any) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	switch command {
	case StateCommand:
		// The state names the terminals' command lines: MoltenTerm's windows and Electron main only.
		if from != fromWindow && from != fromElectron {
			return nil, fmt.Errorf("the keep-awake state is read by MoltenTerm's windows")
		}
		return l.s.keeper.State(), nil
	case CoffeeCommand:
		// The coffee is the user's own click; `molten awake --until-work-ends --workspace` (FR-SHELL-024) will be its
		// command path.
		if from != fromWindow {
			return nil, fmt.Errorf("a coffee is turned on or off from a MoltenTerm window")
		}
		var req CoffeeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.SetCoffee(ctx, req.WorkspaceId, req.On)
	case OverrideCommand:
		if from != fromWindow {
			return nil, fmt.Errorf("a session's sleep policy is set from a MoltenTerm window")
		}
		var req OverrideRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.SetOverride(ctx, req)
	case ShimCommand:
		// Only a local terminal's own link: a remote host's sleep is not this computer's (DS-SHELL-024).
		if from != fromTerminal {
			return nil, fmt.Errorf("the sleep shims report from a local MoltenTerm terminal")
		}
		var req ShimRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.Shim(ctx, req)
	}
	return nil, fmt.Errorf("unknown keep-awake command %q", command)
}

var startOnce sync.Once

// Start registers the route, follows the shells' marks, closed blocks, agent states, workspaces and the settings,
// and applies the rules; wavesrv calls it once at startup (Mission Control's starters).
func Start(hooks Hooks) {
	startOnce.Do(func() {
		s := makeService(hooks)
		attention.OnShellMark(s.observeMark)
		link := &routeLink{s: s, output: make(chan []byte, routeQueueSize)}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, Route); err != nil {
			log.Printf("molten: keep-awake route not started: %v\n", err)
			return
		}
		go s.loop()
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(wps.Event_BlockClose, s.blockClosed)
		rpcClient.EventListener.On(molten.AgentStateEvent, func(*wps.WaveEvent) { s.triggerIfActive() })
		rpcClient.EventListener.On(wps.Event_WorkspaceUpdate, func(*wps.WaveEvent) {
			s.workspaces.clear()
			s.triggerIfActive()
		})
		rpcClient.EventListener.On(wps.Event_Config, func(*wps.WaveEvent) { s.trigger() })
		for _, event := range []string{wps.Event_BlockClose, molten.AgentStateEvent, wps.Event_WorkspaceUpdate, wps.Event_Config} {
			wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: event, AllScopes: true}, nil)
		}
		s.trigger()
	})
}
