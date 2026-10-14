// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The handoffs answer on a leaf of wavesrv's router with plain command names. A list or a send is believed from the
// pane token it carries, never from its route; an answer only from a window, whose source the router stamps (a
// router link's source is believed only when the router maps it to the link the request came in on, as in
// pkg/molten/browseragent/route.go).

const (
	routeQueueSize = 64
	listTimeout    = 10 * time.Second
	// A send waits for the developer's answer, then types the prompt.
	sendTimeout   = DefaultApprovalTimeout + 25*time.Second
	answerTimeout = 5 * time.Second
)

type routeLink struct {
	manager *Manager
	output  chan []byte
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
	if req.Command == "" {
		return true
	}
	// Not here: the router calls SendRpcMessage with its lock held, and checking the source takes it.
	go l.answer(req, ingressLinkId)
	return true
}

func sourceOnIngressLink(source string, ingressLinkId baseds.LinkId) bool {
	return source != "" && ingressLinkId != baseds.NoLinkId && wshutil.DefaultRouter.GetLinkIdForRoute(source) == ingressLinkId
}

func (l *routeLink) answer(req wshutil.RpcMessage, ingressLinkId baseds.LinkId) {
	defer func() {
		panichandler.PanicHandler("molten:agenthandoff:route", recover())
	}()
	timeout := answerTimeout
	switch req.Command {
	case ListCommand:
		timeout = listTimeout
	case SendCommand:
		timeout = sendTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	source := req.Source
	if !sourceOnIngressLink(source, ingressLinkId) {
		source = ""
	}
	data, err := l.handle(ctx, req.Command, source, req.Data)
	if req.ReqId == "" {
		return
	}
	resp := wshutil.RpcMessage{ResId: req.ReqId}
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

func (l *routeLink) handle(ctx context.Context, command string, source string, data any) (any, error) {
	switch command {
	case ListCommand:
		var req ListRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.List(ctx, req)
	case SendCommand:
		var req SendRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Send(ctx, req)
	case AnswerCommand:
		var req AnswerRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Answer(source, req)
	}
	return nil, fmt.Errorf("unknown agent handoff command %q", command)
}

var startOnce sync.Once

// Start registers the handoffs on wavesrv's router; Mission Control's Start calls it once.
func Start() {
	startOnce.Do(func() {
		link := &routeLink{manager: MakeManager(MakeWaveEnv()), output: make(chan []byte, routeQueueSize)}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId); err != nil {
			log.Printf("molten: agent handoff route not started: %v\n", err)
		}
	})
}
