// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

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

// The windows reach the stack through a leaf of wavesrv's router answering plain command names, like the panel move
// (pkg/molten/panelmove/route.go): only a window records and reopens.

const routeTimeout = 5 * time.Second

// Store reads a pane or tab before it closes, and brings an entry back; wcore provides both (it owns tabs, blocks
// and layouts).
type Store struct {
	Capture func(ctx context.Context, req RecordRequest) (Entry, error)
	Restore func(ctx context.Context, e Entry, req ReopenRequest) (ReopenResult, error)
}

type routeLink struct {
	store  Store
	stacks *Stacks
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{Id: RouteId, Policy: localroute.Policy{Default: localroute.AllowWindow}, Handler: l.handle}
}

func (l *routeLink) handle(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	switch command {
	case RecordCommand:
		var req RecordRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return Record(ctx, l.store, l.stacks, req)
	case DropCommand:
		var req DropRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		l.stacks.Drop(req.WorkspaceId, req.Id)
		return nil, nil
	case ReopenCommand:
		var req ReopenRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return ReopenLast(ctx, l.store, l.stacks, req)
	}
	return nil, fmt.Errorf("unknown reopen command %q", command)
}

// Record keeps a pane or tab about to close.
func Record(ctx context.Context, store Store, stacks *Stacks, req RecordRequest) (RecordResult, error) {
	if req.WorkspaceId == "" || req.TabId == "" || (req.Kind == KindPane && req.BlockId == "") {
		return RecordResult{}, fmt.Errorf("a close needs its workspace, its tab and, for a pane, its block")
	}
	if req.Kind != KindPane && req.Kind != KindTab {
		return RecordResult{}, fmt.Errorf("unknown kind %q (pane or tab)", req.Kind)
	}
	e, err := store.Capture(ctx, req)
	if err != nil {
		return RecordResult{}, err
	}
	if e.Id == "" {
		e.Id = uuid.NewString()
	}
	stacks.Push(e)
	return RecordResult{Id: e.Id}, nil
}

// ReopenLast brings the workspace's most recent close back. An entry that fails to come back stays on the stack.
func ReopenLast(ctx context.Context, store Store, stacks *Stacks, req ReopenRequest) (ReopenResult, error) {
	e, ok := stacks.Pop(req.WorkspaceId)
	if !ok {
		return ReopenResult{}, nil
	}
	restored := e
	if e.Pane != nil {
		pane := *e.Pane
		pane.TargetBlockId = stacks.CurrentId(pane.TargetBlockId)
		restored.Pane = &pane
	}
	rtn, err := store.Restore(ctx, restored, req)
	if err != nil {
		stacks.PushBack(e)
		return ReopenResult{}, err
	}
	if e.Target.Kind == KindPane {
		stacks.Reopened(e.Target.BlockId, rtn.BlockId)
	}
	rtn.Reopened, rtn.Kind = true, e.Target.Kind
	if rtn.Name == "" {
		rtn.Name = e.Target.Name
	}
	return rtn, nil
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(store Store) {
	link := &routeLink{store: store, stacks: MakeStacks()}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: reopen route not started: %v\n", err)
	}
}
