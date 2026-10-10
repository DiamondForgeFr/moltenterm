// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package panelmove

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the move through a leaf of wavesrv's router answering a plain command name, like the rail order
// (pkg/molten/railorder/route.go): nothing is declared in pkg/wshrpc. Only a window moves panels (a drag in its tab
// bar); a terminal cannot.

const routeQueueSize = 16
const routeTimeout = 5 * time.Second

// Mover carries the move out; wcore provides it (it owns tabs, blocks and layouts).
type Mover func(ctx context.Context, req MoveRequest) (MoveResult, error)

type routeLink struct {
	move   Mover
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
		panichandler.PanicHandler("molten:panelmove:route", recover())
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
		return nil, fmt.Errorf("panels are moved from MoltenTerm's windows only")
	}
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
	ctx, cancel := context.WithTimeout(context.Background(), routeTimeout)
	defer cancel()
	return l.move(ctx, req)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(move Mover) {
	link := &routeLink{move: move, output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId); err != nil {
		log.Printf("molten: panel move route not started: %v\n", err)
	}
}
