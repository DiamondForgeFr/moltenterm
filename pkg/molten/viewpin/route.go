// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package viewpin

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the pins through a leaf of wavesrv's router answering plain command names, like the reopen
// stack (pkg/molten/reopen/route.go): only a window pins and opens views.

const routeTimeout = 10 * time.Second

// Store reads a view and makes one; wcore provides both (it owns tabs, blocks and layouts).
type Store struct {
	Capture func(ctx context.Context, req CaptureRequest) (Config, error)
	Build   func(ctx context.Context, req BuildRequest) (BuildResult, error)
}

type routeLink struct {
	store Store
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{Id: RouteId, Policy: localroute.Policy{Default: localroute.AllowWindow}, Handler: l.handle}
}

func (l *routeLink) handle(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	switch command {
	case CaptureCommand:
		var req CaptureRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.TabId == "" || req.WorkspaceId == "" {
			return nil, fmt.Errorf("a view to pin needs its workspace and its tab")
		}
		return l.store.Capture(ctx, req)
	case BuildCommand:
		var req BuildRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.WorkspaceId == "" || len(req.Config.Panes) == 0 {
			return nil, fmt.Errorf("a view to open needs its workspace and at least one panel")
		}
		return l.store.Build(ctx, req)
	}
	return nil, fmt.Errorf("unknown view pin command %q", command)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(store Store) {
	link := &routeLink{store: store}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: view pin route not started: %v\n", err)
	}
}
