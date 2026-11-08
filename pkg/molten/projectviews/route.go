// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package projectviews

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the project switch through a leaf of wavesrv's router answering plain command names, like the pins
// (pkg/molten/viewpin/route.go): only a window switches, adds or removes a project.

const (
	// must match frontend/moltenterm-shell/sidebar/workspace-projects-store.ts
	RouteId       = "molten:projectviews"
	SwitchCommand = "moltenprojectswitch"
	RemoveCommand = "moltenprojectremove"
	AssignCommand = "moltenprojectassign"

	routeTimeout = 20 * time.Second
)

type SwitchRequest struct {
	WorkspaceId string `json:"workspaceid"`
	ProjectId   string `json:"projectid"`
}

type RemoveRequest struct {
	WorkspaceId string `json:"workspaceid"`
	ProjectId   string `json:"projectid"`
}

// AssignRequest gives the views of a workspace that has none their projects, after a project was added.
type AssignRequest struct {
	WorkspaceId string `json:"workspaceid"`
}

type Result struct {
	// The view shown after a switch.
	TabId string `json:"tabid,omitempty"`
}

// Store carries the commands out; wcore provides it (it owns the tabs).
type Store struct {
	Switch func(ctx context.Context, req SwitchRequest) (Result, error)
	Remove func(ctx context.Context, req RemoveRequest) (Result, error)
	Assign func(ctx context.Context, req AssignRequest) (Result, error)
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
	case SwitchCommand:
		var req SwitchRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.WorkspaceId == "" || req.ProjectId == "" {
			return nil, fmt.Errorf("a switch needs its workspace and its project")
		}
		return l.store.Switch(ctx, req)
	case RemoveCommand:
		var req RemoveRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.WorkspaceId == "" || req.ProjectId == "" {
			return nil, fmt.Errorf("removing a project needs its workspace and its project")
		}
		return l.store.Remove(ctx, req)
	case AssignCommand:
		var req AssignRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.WorkspaceId == "" {
			return nil, fmt.Errorf("an assignment needs its workspace")
		}
		return l.store.Assign(ctx, req)
	}
	return nil, fmt.Errorf("unknown project views command %q", command)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(store Store) {
	link := &routeLink{store: store}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: project views route not started: %v\n", err)
	}
}
