// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// RequestGuard may refuse a request before the root router forwards it (#1832): a request to a panel's frontend route
// is answered by the window, which cannot tell who asked, so wavesrv checks the caller first. It runs on the router's
// loop, with its lock free.
type RequestGuard func(router *WshRouter, msg RpcMessage, ingressLinkId baseds.LinkId) error

var requestGuard atomic.Pointer[RequestGuard]

// SetRequestGuard installs the root router's request guard (wavesrv's, pkg/wshrpc/wshserver); nil removes it.
func SetRequestGuard(guard RequestGuard) {
	if guard == nil {
		requestGuard.Store(nil)
		return
	}
	requestGuard.Store(&guard)
}

// refuseRequest answers msg with the guard's refusal, on the link it came in on, and tells whether it did.
func (router *WshRouter) refuseRequest(msg RpcMessage, ingressLinkId baseds.LinkId) bool {
	guard := requestGuard.Load()
	if guard == nil || !router.IsRootRouter() {
		return false
	}
	err := (*guard)(router, msg, ingressLinkId)
	if err == nil {
		return false
	}
	log.Printf("[router] refused %s from %q to %q: %v\n", msg.Command, msg.Source, msg.Route, err)
	if msg.ReqId == "" {
		return true
	}
	respBytes, marshalErr := json.Marshal(RpcMessage{ResId: msg.ReqId, Error: err.Error()})
	if marshalErr != nil {
		return true
	}
	router.sendMessageToLink(respBytes, ingressLinkId, baseds.NoLinkId)
	return true
}

// WithCallerContext is ctx as a request from source through ingressLinkId sees it, for the tests of the commands
// that check their caller (metaguard.CallerOf).
func WithCallerContext(ctx context.Context, source string, ingressLinkId baseds.LinkId) context.Context {
	return withRespHandler(ctx, &RpcResponseHandler{ctx: ctx, source: source, ingressLinkId: ingressLinkId, done: &atomic.Bool{}, canceled: &atomic.Bool{}, contextCancelFn: &atomic.Pointer[context.CancelFunc]{}})
}
