// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the stack through a leaf of wavesrv's router answering plain command names, like the panel move
// (pkg/molten/panelmove/route.go): only a window records and reopens.

const routeQueueSize = 16
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
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return RouteId
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
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:reopen:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
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

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if !strings.HasPrefix(source, wshutil.RoutePrefix_Tab) {
		return nil, fmt.Errorf("closed panes and tabs are reopened from MoltenTerm's windows only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), routeTimeout)
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
	link := &routeLink{store: store, stacks: MakeStacks(), output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId); err != nil {
		log.Printf("molten: reopen route not started: %v\n", err)
	}
}
