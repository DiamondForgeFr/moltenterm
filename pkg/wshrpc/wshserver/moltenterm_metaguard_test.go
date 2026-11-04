// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The caller of a molten:* subscription is read from the link it came in on: a window and a local terminal follow
// the event, a remote terminal (or one forging another caller) is refused, other events are untouched (#1914).
func TestMoltenEventSubscribeCallers(t *testing.T) {
	e := routetest.Make(t)
	saved := wshutil.DefaultRouter
	wshutil.DefaultRouter = e.Router
	t.Cleanup(func() { wshutil.DefaultRouter = saved })
	ctxOf := func(from routetest.From) context.Context {
		return wshutil.WithCallerContext(context.Background(), from.Source, from.Link)
	}
	moltenReq := wps.SubscriptionRequest{Event: molten.MorphDesignHandoffEvent, Scopes: []string{"mod-id"}}
	history := wshrpc.CommandEventReadHistoryData{Event: molten.AgentStateEvent, Scope: "workspace:ws", MaxItems: 1}
	for _, from := range []routetest.From{e.Window(), e.Electron(), e.Terminal()} {
		if err := moltenCheckSubscribe(ctxOf(from), moltenReq); err != nil {
			t.Errorf("%s refused: %v", from.Name, err)
		}
		if _, err := WshServerImpl.EventReadHistoryCommand(ctxOf(from), history); err != nil {
			t.Errorf("%s refused the history: %v", from.Name, err)
		}
	}
	if err := moltenCheckSubscribe(context.Background(), moltenReq); err != nil {
		t.Errorf("wavesrv refused: %v", err)
	}
	for _, from := range e.Forged() {
		mustRefuseMoltenEvent(t, from.Name, moltenCheckSubscribe(ctxOf(from), moltenReq))
		_, err := WshServerImpl.EventReadHistoryCommand(ctxOf(from), history)
		mustRefuseMoltenEvent(t, from.Name+" history", err)
		if from.Source != "" {
			mustRefuseMoltenEvent(t, from.Name+" eventsub", WshServerImpl.EventSubCommand(ctxOf(from), moltenReq))
		}
		if err := moltenCheckSubscribe(ctxOf(from), wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}); err != nil {
			t.Errorf("%s refused an event outside molten:: %v", from.Name, err)
		}
	}
}

func mustRefuseMoltenEvent(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused: a remote or unverified terminal cannot follow MoltenTerm's") {
		t.Errorf("%s: %v, want a refusal", name, err)
	}
}
