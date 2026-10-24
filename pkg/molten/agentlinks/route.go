// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlinks

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The registry answers on a leaf of wavesrv's router with plain command names. A watch or a goodbye comes from a local
// terminal's own link and is believed for the terminal its token names, which must be the link's own (localroute);
// reading and controlling only from a window.

const (
	watchTimeout   = maxHold + 5*time.Second
	controlTimeout = 5 * time.Second
	// How often the down links of agents that quit are forgotten.
	pruneEvery = 10 * time.Second
)

type routeLink struct {
	manager *Manager
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: agentlinkwire.RouteId,
		Policy: localroute.Policy{
			Default: localroute.AllowUi,
			Commands: map[string]string{
				agentlinkwire.WatchCommand: localroute.AllowLocalTerminal,
				agentlinkwire.ByeCommand:   localroute.AllowLocalTerminal,
			},
			Refusals: map[string]string{agentlinkwire.WatchCommand: errNotInMoltenTerm, agentlinkwire.ByeCommand: errNotInMoltenTerm},
		},
		Handler:       l.handle,
		RunUnanswered: true,
	}
}

func (l *routeLink) handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	timeout := controlTimeout
	if command == agentlinkwire.WatchCommand {
		timeout = watchTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	switch command {
	case agentlinkwire.WatchCommand:
		var req agentlinkwire.WatchRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Watch(ctx, caller, req)
	case agentlinkwire.ByeCommand:
		var req agentlinkwire.ByeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Bye(caller, req)
	case agentlinkwire.StateCommand:
		var req agentlinkwire.StateRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.State(caller, req)
	case agentlinkwire.ControlCommand:
		var req agentlinkwire.ControlRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Control(caller, req)
	}
	return nil, fmt.Errorf("unknown agent link command %q", command)
}

var (
	runningLock    sync.Mutex
	runningManager *Manager
	startOnce      sync.Once
)

func setRunningManager(m *Manager) {
	runningLock.Lock()
	defer runningLock.Unlock()
	runningManager = m
}

func running() *Manager {
	runningLock.Lock()
	defer runningLock.Unlock()
	return runningManager
}

// Gate refuses a stopped link's calls (FR-CONT-022); nil before the registry starts.
func Gate(source string) error {
	m := running()
	if m == nil {
		return nil
	}
	return m.Gate(source)
}

// OnStop runs fn with the route of each link the developer stops.
func OnStop(fn func(source string)) {
	if m := running(); m != nil {
		m.OnStop(fn)
	}
}

// SetLegacySessions gives the registry the browser sessions of servers that do not report.
func SetLegacySessions(fn func(blockId string) []LegacySession) {
	if m := running(); m != nil {
		m.SetLegacySessions(fn)
	}
}

// Start registers the registry on wavesrv's router and follows the routes going down; Mission Control's Start calls
// it once, before the routes that ask Gate.
func Start() {
	startOnce.Do(func() {
		manager := MakeManager(MakeWaveEnv())
		setRunningManager(manager)
		if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{manager: manager}).route()); err != nil {
			log.Printf("molten: agent links route not started: %v\n", err)
			return
		}
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(wps.Event_RouteDown, func(event *wps.WaveEvent) {
			for _, route := range event.Scopes {
				manager.RouteDown(route)
			}
		})
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_RouteDown, AllScopes: true}, nil)
		go func() {
			defer func() {
				panichandler.PanicHandler("agentlinks:prune", recover())
			}()
			for range time.Tick(pruneEvery) {
				manager.PruneAll()
			}
		}()
	})
}
