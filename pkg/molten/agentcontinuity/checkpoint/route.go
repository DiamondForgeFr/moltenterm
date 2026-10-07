// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The windows and `molten task` reach the store through a leaf of wavesrv's router answering plain command names, like
// the companion (pkg/molten/companion/route.go): nothing is declared in pkg/wshrpc. Later stories add their commands
// here: the agents' writes (#330), the briefing (#180).

const (
	routeQueueSize = 64
	dbTimeout      = 2 * time.Second
	sweepInterval  = 6 * time.Hour
)

type routeLink struct {
	store  *Store
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return molten.TaskRoute
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
		panichandler.PanicHandler("molten:task:route", recover())
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

// A window (its route is stamped by the router) or wsh in a local terminal; a remote host never reads the task memory
// of this machine (NFR-CONT-001).
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func isTerminalSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Proc)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if !isWindowSource(source) && !isTerminalSource(source) {
		return nil, fmt.Errorf("the task checkpoint answers MoltenTerm's windows and local terminals only")
	}
	var req molten.TaskRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	wsId, err := resolveWorkspace(req, isWindowSource(source))
	if err != nil {
		return nil, err
	}
	switch command {
	case molten.TaskReadCommand:
		if req.Create {
			if err := l.store.Ensure(wsId); err != nil {
				return nil, err
			}
		}
		return l.store.View(wsId, req.Section)
	case molten.TaskHistoryCommand:
		return l.store.History(wsId)
	case molten.TaskRestoreCommand:
		if err := l.store.Restore(wsId, req.N); err != nil {
			return nil, err
		}
		return l.store.View(wsId, "")
	case molten.TaskClearCommand:
		if err := l.store.Clear(wsId); err != nil {
			return nil, err
		}
		return l.store.View(wsId, "")
	}
	return nil, fmt.Errorf("unknown task command %q", command)
}

// resolveWorkspace: a window may name the workspace; a terminal names its own block, and gets its own workspace.
func resolveWorkspace(req molten.TaskRequest, window bool) (string, error) {
	if req.BlockId != "" {
		block, err := readTermBlock(req.BlockId)
		if err != nil {
			return "", err
		}
		if block.remote {
			return "", fmt.Errorf("no task checkpoint for a remote terminal")
		}
		return workspaceOfBlock(req.BlockId)
	}
	if !window || req.WorkspaceId == "" {
		return "", fmt.Errorf("no workspace: run molten task in a MoltenTerm terminal")
	}
	if err := ValidWorkspaceId(req.WorkspaceId); err != nil {
		return "", err
	}
	ok, err := workspaceExists(req.WorkspaceId)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("no such workspace")
	}
	return req.WorkspaceId, nil
}

func workspaceOfBlock(blockId string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return "", fmt.Errorf("the block's tab was not found: %w", err)
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return "", fmt.Errorf("the block's workspace was not found: %w", err)
	}
	return wsId, nil
}

func workspaceExists(wsId string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		return false, err
	}
	return ws != nil, nil
}

func readTermBlock(blockId string) (blockFolder, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return blockFolder{}, err
	}
	if block == nil {
		return blockFolder{}, fmt.Errorf("block %s not found", blockId)
	}
	conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if cwd != "" {
		cwd = wavebase.ExpandHomeDirSafe(cwd)
	}
	return blockFolder{cwd: cwd, remote: !isLocalConnName(conn)}, nil
}

// As conncontroller.IsLocalConnName, without importing the connection controller.
func isLocalConnName(conn string) bool {
	return conn == "" || conn == "local" || strings.HasPrefix(conn, "local:")
}

func publishChanged(ev molten.TaskChanged) {
	scopes := []string{waveobj.MakeORef(waveobj.OType_Workspace, ev.WorkspaceId).String()}
	wps.Broker.Publish(wps.WaveEvent{Event: molten.TaskEvent, Scopes: scopes, Data: ev})
}

var defaultLock sync.Mutex
var defaultStore *Store

// Default is wavesrv's store, nil before Start: #330 (agents' writes), #180 (briefing) and #331/#332 (switching) read
// and write the checkpoints through it.
func Default() *Store {
	defaultLock.Lock()
	defer defaultLock.Unlock()
	return defaultStore
}

func setDefault(s *Store) {
	defaultLock.Lock()
	defer defaultLock.Unlock()
	defaultStore = s
}

// StoreRoot is <data dir>/molten/tasks.
func StoreRoot() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "molten", "tasks")
}

var startOnce sync.Once

// Start opens the store, registers the route, follows the agents' turns and sweeps deleted workspaces; wavesrv calls it
// once at startup, after the agent states and the companion.
func Start() {
	startOnce.Do(start)
}

func start() {
	store := MakeStore(StoreRoot())
	store.SetOnChange(publishChanged)
	setDefault(store)
	u := MakeUpdater(store)
	u.runs = attention.AgentRuns
	u.linked = companion.LinkedSession
	u.workspaceOf = workspaceOfBlock
	u.folderOf = readTermBlock
	attention.SetTurnEndListener(u.TurnEnded)
	go u.Run(make(chan struct{}))
	go sweepLoop(store)
	link := &routeLink{store: store, output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, molten.TaskRoute); err != nil {
		log.Printf("molten: task checkpoint route not started: %v\n", err)
		return
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
		if blockId, ok := event.Data.(string); ok && blockId != "" {
			u.ForgetBlock(blockId)
		}
	})
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
}

func sweepLoop(store *Store) {
	defer func() {
		panichandler.PanicHandler("molten:checkpoint:sweep", recover())
	}()
	for {
		store.Sweep(workspaceExists)
		time.Sleep(sweepInterval)
	}
}
