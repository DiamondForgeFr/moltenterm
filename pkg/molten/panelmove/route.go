// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package panelmove

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the move through a leaf of wavesrv's router answering a plain command name, like the rail order
// (pkg/molten/railorder/route.go): nothing is declared in pkg/wshrpc. Only a window moves panels (a drag in its tab
// bar); a terminal cannot.

const routeTimeout = 5 * time.Second

// Mover carries the move out; wcore provides it (it owns tabs, blocks and layouts).
type Mover func(ctx context.Context, req MoveRequest) (MoveResult, error)

func route(move Mover) localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowWindow},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return handle(ctx, move, command, data)
		},
	}
}

func handle(ctx context.Context, move Mover, command string, data any) (any, error) {
	if command != MoveCommand {
		return nil, fmt.Errorf("unknown panel move command %q", command)
	}
	var req MoveRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if err := CheckRequest(req); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	return move(ctx, req)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(move Mover) {
	if _, err := localroute.Register(wshutil.DefaultRouter, route(move)); err != nil {
		log.Printf("molten: panel move route not started: %v\n", err)
	}
}
