// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The sessions answer on a leaf of wavesrv's router with plain command names (the pattern of
// pkg/molten/browsers/route.go): nothing is declared in pkg/wshrpc. The router stamps each request with the route of
// the link it came from, which is what binds a session to its MCP server and keeps terminals off the control commands.

const (
	routeQueueSize        = 64
	helloTimeout          = 10 * time.Second
	callTimeout           = 150 * time.Second
	defaultControlTimeout = 5 * time.Second
)

type routeLink struct {
	manager *Manager
	output  chan []byte

	lock    sync.Mutex
	pending map[string]context.CancelFunc
}

func (l *routeLink) GetPeerInfo() string {
	return mcpbrowser.RouteId
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
	if req.Cancel && req.ReqId != "" {
		// The MCP client cancelled the call (notifications/cancelled).
		l.cancel(req.ReqId)
		return true
	}
	// A command without a reqid wants no answer (emain reports takeover that way), but still runs.
	if req.Command == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) track(reqId string, cancel context.CancelFunc) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.pending[reqId] = cancel
}

func (l *routeLink) untrack(reqId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	delete(l.pending, reqId)
}

func (l *routeLink) cancel(reqId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if cancel := l.pending[reqId]; cancel != nil {
		cancel()
	}
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:browseragent:route", recover())
	}()
	timeout := defaultControlTimeout
	switch req.Command {
	case mcpbrowser.HelloCommand:
		timeout = helloTimeout
	case mcpbrowser.CallCommand:
		timeout = callTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if req.ReqId != "" {
		l.track(req.ReqId, cancel)
		defer l.untrack(req.ReqId)
	}
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(ctx, req.Command, req.Source, req.Data)
	if req.ReqId == "" {
		return
	}
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

func (l *routeLink) handle(ctx context.Context, command string, source string, data any) (any, error) {
	switch command {
	case mcpbrowser.HelloCommand:
		var req mcpbrowser.HelloRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Hello(ctx, source, req)
	case mcpbrowser.CallCommand:
		var req mcpbrowser.CallRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Call(ctx, source, req), nil
	case mcpbrowser.ByeCommand:
		var req mcpbrowser.ByeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		l.manager.Bye(source, req.SessionId)
		return nil, nil
	case mcpbrowser.ControlCommand:
		var req ControlRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Control(source, req)
	case mcpbrowser.StateCommand:
		var req StateRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.PanelSnapshot(source, req.BlockId)
	}
	return nil, fmt.Errorf("unknown browser agent command %q", command)
}

func handleRouteDown(manager *Manager, event *wps.WaveEvent) {
	for _, route := range event.Scopes {
		manager.EndSessionsForRoute(route)
	}
}

var startOnce sync.Once

// Start registers the sessions on wavesrv's router and ends a session when its MCP server's connection goes; Mission
// Control's Start calls it once.
func Start() {
	startOnce.Do(func() {
		manager := MakeManager(MakeWaveEnv())
		link := &routeLink{manager: manager, output: make(chan []byte, routeQueueSize), pending: make(map[string]context.CancelFunc)}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, mcpbrowser.RouteId); err != nil {
			log.Printf("molten: browser agent route not started: %v\n", err)
			return
		}
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(wps.Event_RouteDown, func(event *wps.WaveEvent) { handleRouteDown(manager, event) })
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_RouteDown, AllScopes: true}, nil)
	})
}
