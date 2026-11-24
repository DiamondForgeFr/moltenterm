// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package contexts

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows and Electron main reach the contexts through a leaf of wavesrv's router answering plain command names,
// like the rail order (pkg/molten/railorder/route.go): nothing is declared in pkg/wshrpc. Reads need no call, since the
// client and workspace objects are on every window; only a write comes here, so a terminal never changes a context.

const routeTimeout = 10 * time.Second

// Change is one rule applied to the state: the state after it and the workspaces that moved.
type Change func(State) (State, []string, error)

// Store reads and writes the contexts; wcore provides it. Apply runs a change under the contexts' lock, writes the
// list and the moved workspaces' metas in one transaction and returns the state as written.
type Store struct {
	Read  func(ctx context.Context) (State, error)
	Apply func(ctx context.Context, change Change) (State, error)
	// Landing is the workspace a window lands on when the one it shows is deleted: a free one of the same context, else
	// a new one made in it.
	Landing func(ctx context.Context, deletedWorkspaceId string) (string, error)
}

// Result answers every write: the contexts as written and, for a create, the new context's id.
type Result struct {
	Contexts []Context `json:"contexts"`
	Id       string    `json:"id,omitempty"`
}

type routeLink struct {
	store Store
	newId func() string
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{Id: RouteId, Policy: localroute.Policy{Default: localroute.AllowUi}, Handler: l.handle}
}

func decode[T any](data any) (T, error) {
	var req T
	err := utilfn.ReUnmarshal(&req, data)
	return req, err
}

func (l *routeLink) apply(ctx context.Context, id string, change Change) (any, error) {
	state, err := l.store.Apply(ctx, change)
	if err != nil {
		return nil, err
	}
	return Result{Contexts: state.Contexts, Id: id}, nil
}

func (l *routeLink) handle(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	switch command {
	case CreateCommand:
		req, err := decode[CreateRequest](data)
		if err != nil {
			return nil, err
		}
		id := l.newId()
		return l.apply(ctx, id, func(s State) (State, []string, error) { return s.Create(req, id) })
	case UpdateCommand:
		req, err := decode[UpdateRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, "", func(s State) (State, []string, error) { return s.Update(req) })
	case DeleteCommand:
		req, err := decode[DeleteRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, "", func(s State) (State, []string, error) { return s.Delete(req) })
	case AssignCommand:
		req, err := decode[AssignRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, "", func(s State) (State, []string, error) { return s.Assign(req) })
	case TouchCommand:
		req, err := decode[TouchRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, "", func(s State) (State, []string, error) {
			next, err := s.Touch(req)
			return next, nil, err
		})
	case ShapesCommand:
		req, err := decode[ShapesRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, "", func(s State) (State, []string, error) {
			next, err := s.AssignShapes(req)
			return next, nil, err
		})
	case LandingCommand:
		req, err := decode[LandingRequest](data)
		if err != nil {
			return nil, err
		}
		if l.store.Landing == nil {
			return nil, fmt.Errorf("no landing for a deleted workspace")
		}
		id, err := l.store.Landing(ctx, req.WorkspaceId)
		if err != nil {
			return nil, err
		}
		state, err := l.store.Read(ctx)
		if err != nil {
			return nil, err
		}
		return Result{Contexts: state.Contexts, Id: id}, nil
	case ListCommand:
		state, err := l.store.Read(ctx)
		if err != nil {
			return nil, err
		}
		return Result{Contexts: state.Contexts}, nil
	}
	return nil, fmt.Errorf("unknown contexts command %q", command)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(store Store) {
	link := &routeLink{store: store, newId: uuid.NewString}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: contexts route not started: %v\n", err)
	}
}
