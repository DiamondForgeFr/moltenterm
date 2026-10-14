// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The review sessions answer on a leaf of wavesrv's router with plain command names, like the durable sessions: a
// request's source is believed only when it is a local terminal on its own link or a window (localroute.OnLink, the
// #374 rule), so remote and SSH terminals are refused. The MCP server's commands come from the agent's terminal; the
// windows start, end and select.

const (
	routeQueueSize = 64
	controlTimeout = 10 * time.Second
	callTimeout    = 60 * time.Second
)

type routeLink struct {
	manager *Manager
	output  chan []byte
	// localSource tells whether a request's source is a local terminal or a window on the link it came in on.
	localSource func(source string, ingressLinkId baseds.LinkId) bool

	lock    sync.Mutex
	pending map[string]context.CancelFunc
}

func (l *routeLink) GetPeerInfo() string {
	return mcpreview.RouteId
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
	if req.Cancel && req.ReqId != "" {
		l.cancel(req.ReqId)
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	// Source checks take the router's lock, which is held while it calls SendRpcMessage.
	go l.answer(req, ingressLinkId)
	return true
}

func (l *routeLink) track(reqId string, cancel context.CancelFunc) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.pending[reqId] = cancel
}

func (l *routeLink) untrack(reqId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	delete(l.pending, reqId)
}

func (l *routeLink) cancel(reqId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if cancel := l.pending[reqId]; cancel != nil {
		cancel()
	}
}

func (l *routeLink) answer(req wshutil.RpcMessage, ingressLinkId baseds.LinkId) {
	defer func() {
		panichandler.PanicHandler("molten:reviewsession:route", recover())
	}()
	timeout := controlTimeout
	switch req.Command {
	case mcpreview.CallCommand:
		timeout = callTimeout
	case mcpreview.StartCommand:
		timeout = startTimeout + controlTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	l.track(req.ReqId, cancel)
	defer l.untrack(req.ReqId)
	source := req.Source
	if l.localSource == nil || !l.localSource(source, ingressLinkId) {
		source = ""
	}
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(ctx, req.Command, source, req.Data)
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

func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func isTerminalSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Proc)
}

func (l *routeLink) handle(ctx context.Context, command string, source string, data any) (any, error) {
	switch command {
	case mcpreview.HelloCommand:
		if !isTerminalSource(source) {
			return nil, fmt.Errorf("%s", mcpreview.ErrNotInMoltenTerm)
		}
		var req mcpreview.HelloRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Hello(ctx, source, req)
	case mcpreview.CallCommand:
		var req mcpreview.CallRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Call(ctx, source, req), nil
	case mcpreview.ByeCommand:
		var req mcpreview.ByeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		l.manager.Bye(source, req.ConnId)
		return nil, nil
	}
	if !isWindowSource(source) && !isTerminalSource(source) {
		return nil, fmt.Errorf("review sessions are answered to MoltenTerm's windows and local terminals only")
	}
	switch command {
	case mcpreview.ListCommand:
		return l.manager.List(ctx), nil
	case mcpreview.GetCommand:
		var key mcpreview.SessionKey
		if err := utilfn.ReUnmarshal(&key, data); err != nil {
			return nil, err
		}
		return l.manager.Get(ctx, key), nil
	case mcpreview.PostsCommand:
		var key mcpreview.SessionKey
		if err := utilfn.ReUnmarshal(&key, data); err != nil {
			return nil, err
		}
		return l.manager.Posts(ctx, key)
	}
	// Starting, ending and selecting are the Review tab's: a terminal, where an agent may run, cannot.
	if !isWindowSource(source) {
		return nil, fmt.Errorf("review sessions are started and ended from a MoltenTerm window")
	}
	switch command {
	case mcpreview.StartCommand:
		var req mcpreview.StartRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Start(ctx, strings.TrimPrefix(source, wshutil.RoutePrefix_Tab), req)
	case mcpreview.EndCommand:
		var key mcpreview.SessionKey
		if err := utilfn.ReUnmarshal(&key, data); err != nil {
			return nil, err
		}
		return nil, l.manager.End(ctx, key)
	case mcpreview.SelectionCommand:
		var req mcpreview.SelectionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.SetSelection(ctx, req)
	case mcpreview.SetHeadCommand:
		var req mcpreview.SetHeadRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.SetHead(ctx, req)
	case mcpreview.BriefCommand:
		var key mcpreview.SessionKey
		if err := utilfn.ReUnmarshal(&key, data); err != nil {
			return nil, err
		}
		return l.manager.Brief(ctx, key)
	}
	return nil, fmt.Errorf("unknown review session command %q", command)
}
