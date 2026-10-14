// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// The windows and `molten session` reach the sessions through a leaf of wavesrv's router answering plain command
// names, like the agent states (pkg/molten/attention/agentroute.go): nothing is declared in pkg/wshrpc.

const (
	actionTimeout = 15 * time.Second
	// Reconnecting may wait on Wave's prompts (a password, a host key).
	hostReconnectTimeout = 90 * time.Second
)

type routeLink struct {
	model   *Model
	actions *Actions
}

// route: the windows and `molten session` in a local terminal (#159); ending a list of sessions at once is a window's
// action, after its confirmation.
func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: molten.DurableSessionsRoute,
		Policy: localroute.Policy{
			Default:  localroute.AllowLocal,
			Commands: map[string]string{molten.DurableSessionsCleanupCommand: localroute.AllowWindow},
			Refusals: map[string]string{molten.DurableSessionsCleanupCommand: "cleaning up sessions is done from a MoltenTerm window"},
		},
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return l.handle(command, caller, data)
		},
	}
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	switch command {
	case molten.DurableSessionsListCommand:
		return l.model.Snapshot()
	case molten.DurableSessionsShowCommand:
		var req molten.DurableSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if req.TabId == "" && caller.IsWindow {
			req.TabId = caller.TabId
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.ShowAt(ctx, req.Id, req.TabId, req.PanePlacement)
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
