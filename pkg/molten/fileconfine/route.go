// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package fileconfine

import (
	"context"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows ask wavesrv where a path really is through a leaf of its router answering a plain command name, like the
// panel move (pkg/molten/panelmove/route.go): nothing is declared in pkg/wshrpc. Local terminals may ask too (molten
// files, FR-FILE-002); a remote host may not, its paths are not this computer's.

func route() localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowLocal},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return handle(command, data)
		},
	}
}

func handle(command string, data any) (any, error) {
	if command != CheckCommand {
		return nil, fmt.Errorf("unknown file confinement command %q", command)
	}
	var req CheckRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if req.Path == "" || req.Project == "" {
		return nil, fmt.Errorf("a file confinement check needs a path and a project")
	}
	return Check(req.Path, req.Project), nil
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute() {
	if _, err := localroute.Register(wshutil.DefaultRouter, route()); err != nil {
		log.Printf("molten: file confinement route not started: %v\n", err)
	}
}
