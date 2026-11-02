// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinks"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// The review sessions answer on a leaf of wavesrv's router with plain command names, like the durable sessions: a
// request's source is believed only when it is a local terminal on its own link or a window (localroute, the #374
// rule), so remote and SSH terminals are refused. The MCP server's commands come from the agent's terminal; the
// windows start, end and select.

const (
	controlTimeout = 10 * time.Second
	callTimeout    = 60 * time.Second
)

type routeLink struct {
	manager *Manager
}

// route: the MCP server's commands from a local terminal; reading from the windows and local terminals; starting,
// ending and selecting are the Review tab's: a terminal, where an agent may run, cannot (DS-REV-011).
func (l *routeLink) route() localroute.Route {
	mcp := []string{mcpreview.HelloCommand, mcpreview.CallCommand, mcpreview.ByeCommand}
	policy := localroute.Policy{
		Default: localroute.AllowWindow,
		Commands: map[string]string{
			mcpreview.ListCommand:  localroute.AllowLocal,
			mcpreview.GetCommand:   localroute.AllowLocal,
			mcpreview.PostsCommand: localroute.AllowLocal,
		},
		Refusals: map[string]string{},
	}
	for _, command := range mcp {
		policy.Commands[command] = localroute.AllowLocalTerminal
		policy.Refusals[command] = mcpreview.ErrNotInMoltenTerm
	}
	return localroute.Route{
		Id:     mcpreview.RouteId,
		Policy: policy,
		Handler: func(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
			timeout := controlTimeout
			switch command {
			case mcpreview.CallCommand:
				timeout = callTimeout
			case mcpreview.StartCommand:
				timeout = startTimeout + controlTimeout
			}
			ctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			return l.handle(ctx, command, caller, data)
		},
	}
}

func (l *routeLink) handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	source := caller.Source
	switch command {
	case mcpreview.HelloCommand:
		var req mcpreview.HelloRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := agentlinks.Gate(source); err != nil {
			return nil, err
		}
		return l.manager.Hello(ctx, source, req)
	case mcpreview.CallCommand:
		var req mcpreview.CallRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		// The developer stopped this server's link from the terminal's connections menu (FR-CONT-022).
		if err := agentlinks.Gate(source); err != nil {
			return mcpbrowser.ErrorResult(err.Error()), nil
		}
		return l.manager.Call(ctx, source, req), nil
	case mcpreview.ByeCommand:
		var req mcpreview.ByeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		l.manager.Bye(source, req.ConnId)
		return nil, nil
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
	case mcpreview.StartCommand:
		var req mcpreview.StartRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Start(ctx, caller.TabId, req)
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
	case mcpreview.AskCommand:
		var req mcpreview.AskRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.manager.Ask(ctx, req)
	case mcpreview.AskCancelCommand:
		var req mcpreview.AskCancelRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.manager.CancelQuestion(ctx, req)
	}
	return nil, fmt.Errorf("unknown review session command %q", command)
}
