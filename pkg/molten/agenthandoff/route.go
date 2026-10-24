// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinks"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The handoffs answer on a leaf of wavesrv's router with plain command names. A list or a send comes from a local
// terminal's own link (`molten agent send`, the browser MCP server) and is believed from the pane token it carries,
// never from its route, like an MCP server's link notice; an answer only from a window or Electron main (localroute).

const (
	listTimeout = 10 * time.Second
	// A send waits for the developer's answer, then types the prompt.
	sendTimeout   = DefaultApprovalTimeout + 25*time.Second
	answerTimeout = 5 * time.Second
)

type routeLink struct {
	manager *Manager
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: RouteId,
		Policy: localroute.Policy{
			Default: localroute.AllowUi,
			Commands: map[string]string{
				ListCommand:       localroute.AllowLocalTerminal,
				SendCommand:       localroute.AllowLocalTerminal,
				LinkNoticeCommand: localroute.AllowLocalTerminal,
			},
			Refusals: map[string]string{ListCommand: errRemote, SendCommand: errRemote, LinkNoticeCommand: errRemote},
		},
		Handler:       l.handle,
		RunUnanswered: true,
	}
}

func (l *routeLink) handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	timeout := answerTimeout
	switch command {
	case ListCommand:
		timeout = listTimeout
	case SendCommand:
		timeout = sendTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// The developer stopped this MCP server's link from the terminal's connections menu (FR-CONT-022).
	if command == ListCommand || command == SendCommand {
		if err := agentlinks.Gate(caller.Source); err != nil {
			return nil, err
		}
	}
	switch command {
	case PairsCommand:
		var req PairsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Pairs(ctx, caller.Source, req)
	case ForgetCommand:
		var req ForgetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Forget(caller.Source, req)
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
	case LinkNoticeCommand:
		var req LinkNoticeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.LinkNotice(ctx, req)
	case AnswerCommand:
		var req AnswerRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.Answer(caller.Source, req)
	}
	return nil, fmt.Errorf("unknown agent handoff command %q", command)
}

var startOnce sync.Once

// Start registers the handoffs on wavesrv's router; Mission Control's Start calls it once.
func Start() {
	startOnce.Do(func() {
		link := &routeLink{manager: MakeManager(MakeWaveEnv())}
		if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
			log.Printf("molten: agent handoff route not started: %v\n", err)
		}
	})
}
