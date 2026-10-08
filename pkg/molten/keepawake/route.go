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

const (
	routeQueueSize = 64
	// The rules are applied this often while a coffee is on or the policy needs them, and at once on an agent state,
	// a shell mark, a block's close or a workspace change; the grace is shown to the second by the windows.
	tickInterval  = 2 * time.Second
	pokeDebounce  = 200 * time.Millisecond
	storeTimeout  = 3 * time.Second
	locateTimeout = 2 * time.Second
	// Where a block is changes rarely (a pane moved to another tab): looked up again after this.
	locateCacheTtl = 30 * time.Second
)

// Hooks are what other parts of wavesrv give the keeper; pkg/blockcontroller wires them (moltenterm_keepawake.go).
type Hooks struct {
	// CommandBlocks: the cmd blocks whose command runs now.
	CommandBlocks func() []string
	// MissionWorkspaces: the workspaces whose linked project has a Mission Control run going.
	MissionWorkspaces func(ctx context.Context) []string
}

type service struct {
	keeper   *Keeper
	commands *commandTracker
	locate   *locateCache
	poke     chan struct{}
}

type locatedBlock struct {
	info BlockInfo
	at   time.Time
}

type locateCache struct {
	lock    sync.Mutex
	entries map[string]locatedBlock
}

func (c *locateCache) get(blockId string, now time.Time) (BlockInfo, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[blockId]
	if !ok || now.Sub(e.at) > locateCacheTtl {
		return BlockInfo{}, false
	}
	return e.info, true
}

func (c *locateCache) put(blockId string, info BlockInfo, now time.Time) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.entries[blockId] = locatedBlock{info: info, at: now}
}

func (c *locateCache) forget(blockId string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	delete(c.entries, blockId)
}

func isLocalConn(conn string) bool {
	return conn == "" || conn == "local" || strings.HasPrefix(conn, "local:") || strings.HasPrefix(conn, "wsl://")
}

func (s *service) locateBlock(ctx context.Context, blockId string) (BlockInfo, bool) {
	now := time.Now()
	if info, ok := s.locate.get(blockId, now); ok {
		return info, true
	}
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
	info := BlockInfo{
		WorkspaceId: wsId,
		Remote:      !isLocalConn(block.Meta.GetString(waveobj.MetaKey_Connection, "")),
		Cmd:         block.Meta.GetString(waveobj.MetaKey_Cmd, ""),
	}
	s.locate.put(blockId, info, now)
	return info, true
}

func workspaceName(ctx context.Context, wsId string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		// Unknown is not deleted: the coffee stays.
		return "", true
	}
	if ws == nil {
		return "", false
	}
	return ws.Name, true
}

func locateNames(ctx context.Context, blockId string) (string, string, string) {
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
	name, _ := workspaceName(ctx, wsId)
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

func publishState(state State) {
	wps.Broker.Publish(wps.WaveEvent{Event: Event, Data: state})
}

func notify(input molten.NotificationInput) {
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:keepawake:notify", recover())
		}()
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		defer cancel()
		if err := attention.PublishNotification(ctx, input); err != nil {
			log.Printf("molten: keep-awake notification: %v\n", err)
		}
	}()
}

func makeService(hooks Hooks) *service {
	s := &service{commands: makeCommandTracker(), locate: &locateCache{entries: map[string]locatedBlock{}}, poke: make(chan struct{}, 1)}
	sources := WorkSources{
		Agents:            attention.AgentRuns,
		Commands:          s.commands.snapshot,
		CommandBlocks:     hooks.CommandBlocks,
		Locate:            s.locateBlock,
		MissionWorkspaces: hooks.MissionWorkspaces,
	}
	s.keeper = MakeKeeper(Env{
		Now:          time.Now,
		Policy:       currentPolicy,
		Work:         func(ctx context.Context) Work { return ComputeWork(ctx, sources) },
		Workspace:    workspaceName,
		LocateNames:  locateNames,
		Notify:       notify,
		Publish:      publishState,
		ProcessAlive: processAlive,
		ProcessName:  processName,
	})
	return s
}

func (s *service) trigger() {
	select {
	case s.poke <- struct{}{}:
	default:
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
		case <-s.poke:
			time.Sleep(pokeDebounce)
		}
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		s.keeper.Evaluate(ctx)
		cancel()
	}
}

func (s *service) observeMark(blockId string, mark attention.ShellMark) {
	switch mark.Kind {
	case attention.ShellMarkCommand, attention.ShellMarkDone, attention.ShellMarkPrompt:
		s.commands.observe(blockId, mark.Kind, mark.Cmd)
		s.trigger()
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
	s.trigger()
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
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:keepawake:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
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

// isWindowSource tells a MoltenTerm window apart from a terminal: the router stamps the source of every link that has
// a route of its own, so a program in a terminal cannot pass for a window.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	switch command {
	case StateCommand:
		return l.s.keeper.State(), nil
	case CoffeeCommand:
		// The coffee is the user's own click; `molten awake --until-work-ends --workspace` (FR-SHELL-024) will be its
		// command path.
		if !isWindowSource(source) {
			return nil, fmt.Errorf("a coffee is turned on or off from a MoltenTerm window")
		}
		var req CoffeeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.SetCoffee(ctx, req.WorkspaceId, req.On)
	case OverrideCommand:
		if !isWindowSource(source) {
			return nil, fmt.Errorf("a session's sleep policy is set from a MoltenTerm window")
		}
		var req OverrideRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.SetOverride(ctx, req)
	case ShimCommand:
		var req ShimRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.keeper.Shim(ctx, req)
	}
	return nil, fmt.Errorf("unknown keep-awake command %q", command)
}

var startOnce sync.Once

// Start registers the route, follows the shells' marks, closed blocks, agent states and workspaces, and applies the
// rules; wavesrv calls it once at startup (Mission Control's starters).
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
		rpcClient.EventListener.On(molten.AgentStateEvent, func(*wps.WaveEvent) { s.trigger() })
		rpcClient.EventListener.On(wps.Event_WorkspaceUpdate, func(*wps.WaveEvent) { s.trigger() })
		for _, event := range []string{wps.Event_BlockClose, molten.AgentStateEvent, wps.Event_WorkspaceUpdate} {
			wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: event, AllScopes: true}, nil)
		}
		s.trigger()
	})
}
