// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows and `molten session` reach the sessions through a leaf of wavesrv's router answering plain command
// names, like the agent states (pkg/molten/attention/agentroute.go): nothing is declared in pkg/wshrpc.

const (
	routeQueueSize = 64
	actionTimeout  = 15 * time.Second
	// Reconnecting may wait on Wave's prompts (a password, a host key).
	hostReconnectTimeout = 90 * time.Second
)

type routeLink struct {
	output  chan []byte
	model   *Model
	actions *Actions
}

func (l *routeLink) GetPeerInfo() string {
	return molten.DurableSessionsRoute
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
		panichandler.PanicHandler("molten:sessions:route", recover())
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

// isWindowSource tells a request from a MoltenTerm window apart from one sent by a local terminal: the router stamps the
// source of every leaf link that has a route of its own (wsh in a shell), so a local terminal cannot pass for a tab.
// A connected SSH host is a router Wave trusts: the sources it forwards are not stamped, as for Wave's own commands.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

// isTerminalSource: wsh in a local terminal (`molten session`, #159).
func isTerminalSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Proc)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if !isWindowSource(source) && !isTerminalSource(source) {
		return nil, fmt.Errorf("sessions are answered to MoltenTerm's windows and terminals only")
	}
	switch command {
	case molten.DurableSessionsListCommand:
		return l.model.Snapshot()
	case molten.DurableSessionsShowCommand:
		var req molten.DurableSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.TabId == "" && isWindowSource(source) {
			req.TabId = strings.TrimPrefix(source, wshutil.RoutePrefix_Tab)
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.Show(ctx, req.Id, req.TabId)
	case molten.DurableSessionsEndCommand:
		var req molten.DurableSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.End(ctx, req.Id, req.CallerBlockId)
	case molten.DurableSessionsReconnectCommand:
		var req molten.DurableSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), hostReconnectTimeout)
		defer cancel()
		return nil, l.actions.Reconnect(ctx, req.Id)
	case molten.DurableSessionsCleanupCommand:
		// Ending a list of sessions at once is a window's action, after its confirmation.
		if !isWindowSource(source) {
			return nil, fmt.Errorf("cleaning up sessions is done from a MoltenTerm window")
		}
		var req molten.DurableSessionsCleanupRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.Cleanup(ctx, req.Ids)
	}
	return nil, fmt.Errorf("unknown sessions command %q", command)
}
