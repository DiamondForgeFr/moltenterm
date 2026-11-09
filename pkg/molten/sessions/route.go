// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package sessions

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
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
// action, after its confirmation. A terminal reaches only its own workspace's sessions (#2120, workspaceScope).
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

// workspaceScope is the workspace a caller's requests are confined to (#2120): a terminal's own, read from the block its
// token was issued to, never from the request. The windows (the Sessions panel) see every workspace: "".
func (l *routeLink) workspaceScope(caller localroute.Caller) (string, error) {
	if caller.IsUi() {
		return "", nil
	}
	if caller.BlockId != "" {
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		if wsId, err := l.actions.ops.WorkspaceOfBlock(ctx, caller.BlockId); err == nil && wsId != "" {
			return wsId, nil
		}
	}
	return "", uimsg.Errorf(uimsg.Make("sessions.scope.noworkspace"), "this terminal is in no workspace, so it reaches no session: use the Sessions panel")
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	if command == molten.DurableSessionsCleanupCommand {
		var req molten.DurableSessionsCleanupRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.Cleanup(ctx, req.Ids)
	}
	if !isSessionCommand(command) {
		return nil, fmt.Errorf("unknown sessions command %q", command)
	}
	wsId, err := l.workspaceScope(caller)
	if err != nil {
		return nil, err
	}
	if command == molten.DurableSessionsListCommand {
		list, err := l.model.Snapshot()
		return scopedList(list, wsId), err
	}
	var req molten.DurableSessionRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	switch command {
	case molten.DurableSessionsShowCommand:
		if req.TabId == "" && caller.IsWindow {
			req.TabId = caller.TabId
		}
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		return l.actions.ShowIn(ctx, req.Id, req.TabId, req.PanePlacement, wsId)
	case molten.DurableSessionsEndCommand:
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		// The self check takes the block the caller's token names: a request's callerblockid is the sender's word.
		return l.actions.EndIn(ctx, req.Id, caller.BlockId, wsId)
	}
	ctx, cancel := context.WithTimeout(context.Background(), hostReconnectTimeout)
	defer cancel()
	return nil, l.actions.ReconnectIn(ctx, req.Id, wsId)
}

func isSessionCommand(command string) bool {
	switch command {
	case molten.DurableSessionsListCommand, molten.DurableSessionsShowCommand, molten.DurableSessionsEndCommand, molten.DurableSessionsReconnectCommand:
		return true
	}
	return false
}
