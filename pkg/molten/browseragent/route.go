// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The sessions answer on a leaf of wavesrv's router with plain command names (the pattern of
// pkg/molten/browsers/route.go): nothing is declared in pkg/wshrpc. The router stamps a leaf's requests with the
// leaf's route, but a router link (an SSH connserver, the windows' websocket) forwards whatever source its sender
// wrote: localroute believes a source only from a local terminal's own leaf or the windows' websocket. That binds a
// session to its MCP server's connection in a local terminal and keeps terminals and remote hosts off the control
// commands (#662).

const (
	helloTimeout = 10 * time.Second
	// A call may wait 2 minutes for the user's site permission, then load a page for up to 30 seconds.
	callTimeout           = 190 * time.Second
	defaultControlTimeout = 5 * time.Second
	// Typing waits for the process table and the terminal.
	shareTellTimeout = 15 * time.Second
)

type routeLink struct {
	manager *Manager
}

func (l *routeLink) route() localroute.Route {
	session := map[string]string{
		mcpbrowser.HelloCommand: localroute.AllowLocalTerminal,
		mcpbrowser.CallCommand:  localroute.AllowLocalTerminal,
		mcpbrowser.ByeCommand:   localroute.AllowLocalTerminal,
	}
	refusals := map[string]string{}
	for command := range session {
		refusals[command] = mcpbrowser.ErrRemotePane
	}
	return localroute.Route{
		Id:            mcpbrowser.RouteId,
		Policy:        localroute.Policy{Default: localroute.AllowUi, Commands: session, Refusals: refusals},
		Handler:       l.handle,
		RunUnanswered: true,
	}
}

func commandTimeout(command string) time.Duration {
	switch command {
	case mcpbrowser.HelloCommand:
		return helloTimeout
	case mcpbrowser.CallCommand, mcpbrowser.DownloadCommand:
		return callTimeout
	case mcpbrowser.ShareTellCommand:
		return shareTellTimeout
	}
	return defaultControlTimeout
}

func (l *routeLink) handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout(command))
	defer cancel()
	source := caller.Source
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
	case mcpbrowser.AnswerCommand:
		var req AnswerRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Answer(source, req)
	case mcpbrowser.SiteCommand:
		var req SiteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.SetSite(source, req)
	case mcpbrowser.DownloadCommand:
		var req DownloadRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.AskDownload(ctx, source, req)
	case mcpbrowser.ListCommand:
		var req ListRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.ListSessions(ctx, source, req)
	case mcpbrowser.ShareCommand:
		var req ShareRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Share(ctx, source, req)
	case mcpbrowser.ShareTellCommand:
		var req ShareTellRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.ShareTell(ctx, source, req)
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
		setRunningManager(manager)
		if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{manager: manager}).route()); err != nil {
			log.Printf("molten: browser agent route not started: %v\n", err)
			return
		}
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(wps.Event_RouteDown, func(event *wps.WaveEvent) { handleRouteDown(manager, event) })
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_RouteDown, AllScopes: true}, nil)
	})
}
