// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the rail order through a leaf of wavesrv's router answering plain command names, like the first
// run (pkg/molten/onboarding/route.go): nothing is declared in pkg/wshrpc, the package upstream changes most.

const routeQueueSize = 64
const routeTimeout = 5 * time.Second

// Mover applies a move and returns the new order; wcore provides it, since the order sorts Wave's workspace list.
type Mover func(ctx context.Context, req MoveRequest) ([]string, error)

// MoveCheck may refuse a move before it is written, given the current order. Product groups (FR-MC-027, #348) set one:
// a member moves within its group only, a product as a block.
type MoveCheck func(ctx context.Context, order []string, req MoveRequest) error

var checkLock sync.Mutex
var moveCheck MoveCheck

func SetMoveCheck(fn MoveCheck) {
	checkLock.Lock()
	defer checkLock.Unlock()
	moveCheck = fn
}

func getMoveCheck() MoveCheck {
	checkLock.Lock()
	defer checkLock.Unlock()
	return moveCheck
}

// CheckMove runs the move check, if one is set.
func CheckMove(ctx context.Context, order []string, req MoveRequest) error {
	fn := getMoveCheck()
	if fn == nil {
		return nil
	}
	return fn(ctx, order, req)
}

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
		panichandler.PanicHandler("molten:railorder:route", recover())
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

// The router stamps the source of every leaf link that has a route of its own, so a local terminal cannot pass for a
// window.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if !isWindowSource(source) {
		return nil, fmt.Errorf("the rail order answers MoltenTerm windows only")
	}
	if command != MoveCommand {
		return nil, fmt.Errorf("unknown rail order command %q", command)
	}
	var req MoveRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
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
		log.Printf("molten: rail order route not started: %v\n", err)
	}
}
