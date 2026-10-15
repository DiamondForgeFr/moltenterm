// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the first run through a leaf of wavesrv's router answering plain command names, like the agent
// companion (pkg/molten/companion/route.go): nothing is declared in pkg/wshrpc. Steps that need wavesrv (#162's agent
// detection, #165's folder scan) add their commands with HandleCommand.

const routeTimeout = 5 * time.Second

// CommandHandler answers one command of the route; source is the verified window source of the caller.
type CommandHandler func(ctx context.Context, source string, data any) (any, error)

var handlersLock sync.Mutex
var handlers = make(map[string]CommandHandler)

// HandleCommand adds a command to the route; the built-in commands cannot be replaced. Like them, it answers windows
// only.
func HandleCommand(name string, fn CommandHandler) error {
	if name == UpdateCommand || name == StateCommand || name == PanelCommand {
		return fmt.Errorf("command %q is the first run's own", name)
	}
	handlersLock.Lock()
	defer handlersLock.Unlock()
	handlers[name] = fn
	return nil
}

func getHandler(name string) CommandHandler {
	handlersLock.Lock()
	defer handlersLock.Unlock()
	return handlers[name]
}

type panelRequest struct {
	WorkspaceId string `json:"workspaceid"`
}

// Every command, the ones steps add included, answers windows only.
var firstRunRoute = localroute.Route{Id: RouteId, Policy: localroute.Policy{Default: localroute.AllowWindow}, Handler: handle}

func handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	source := caller.Source
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	switch command {
	case StateCommand:
		state, ok, err := CurrentState(ctx)
		if err != nil || !ok {
			return nil, err
		}
		return state, nil
	case UpdateCommand:
		var update Update
		if err := utilfn.ReUnmarshal(&update, data); err != nil {
			return nil, err
		}
		return ApplyWindowUpdate(ctx, update)
	case PanelCommand:
		var req panelRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return FindPanel(ctx, req.WorkspaceId)
	}
	fn := getHandler(command)
	if fn == nil {
		return nil, fmt.Errorf("unknown first run command %q", command)
	}
	return fn(ctx, source, data)
}

func handleBlockClose(event *wps.WaveEvent) {
	defer func() {
		panichandler.PanicHandler("molten:onboarding:blockclose", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), routeTimeout)
	defer cancel()
	// Most closed blocks are terminals of a run long finished: only a run in progress is looked at further.
	state, ok, err := CurrentState(ctx)
	if err != nil || !ok || state.Done {
		return
	}
	if err := CheckPanelClosed(ctx); err != nil {
		log.Printf("molten: first run panel closed: %v\n", err)
	}
}

// StartRoute registers the route and follows closed blocks; wavesrv calls it once, after the start rules.
func StartRoute() {
	if _, err := localroute.Register(wshutil.DefaultRouter, firstRunRoute); err != nil {
		log.Printf("molten: first run route not started: %v\n", err)
		return
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, handleBlockClose)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
}
