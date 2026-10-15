// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func makeTestLink(t *testing.T, sessions ...molten.DurableSession) (*routetest.Env, *localroute.Link, *fakeOps) {
	t.Helper()
	a, _, ops := makeTestActions(sessions...)
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{model: a.model, actions: a}).route())
	if err != nil {
		t.Fatal(err)
	}
	return e, link, ops
}

var allSessionCommands = []string{molten.DurableSessionsListCommand, molten.DurableSessionsShowCommand, molten.DurableSessionsEndCommand,
	molten.DurableSessionsReconnectCommand, molten.DurableSessionsCleanupCommand}

func TestRouteRefusesForwardedCallers(t *testing.T) {
	e, link, ops := makeTestLink(t, detachedS)
	data := map[string]any{"id": "detached", "ids": []string{"detached"}}
	for _, command := range allSessionCommands {
		if command == molten.DurableSessionsCleanupCommand {
			routetest.MustRefuseWith(t, link, e.NonLocal(), command, data, "from a MoltenTerm window")
			continue
		}
		routetest.MustRefuse(t, link, e.NonLocal(), command, data)
	}
	if len(ops.calls) != 0 {
		t.Fatalf("refused caller acted on a session: %s", ops.trace())
	}
}

func TestRouteAnswersVerifiedLocalCallers(t *testing.T) {
	e, link, _ := makeTestLink(t, detachedS)
	for _, from := range []routetest.From{e.Window(), e.Terminal()} {
		if data, errStr := routetest.Ask(t, link, from, molten.DurableSessionsListCommand, nil); errStr != "" || data == nil {
			t.Fatalf("local list for %s: %v %q", from.Name, data, errStr)
		}
	}
}

func TestRouteCallers(t *testing.T) {
	e, link, ops := makeTestLink(t, detachedS)
	_, errStr := routetest.Ask(t, link, e.Terminal(), molten.DurableSessionsCleanupCommand, map[string]any{"ids": []string{"detached"}})
	if !strings.Contains(errStr, "window") {
		t.Fatalf("cleanup from a terminal: %q", errStr)
	}
	if len(ops.calls) != 0 {
		t.Fatalf("refused cleanup ended something: %s", ops.trace())
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), "moltensessionsnope", nil); !strings.Contains(errStr, "unknown") {
		t.Fatalf("unknown command: %q", errStr)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), molten.DurableSessionsEndCommand, "not an object"); errStr == "" {
		t.Fatalf("bad data accepted")
	}
}

func TestRouteShowUsesTheWindowsTab(t *testing.T) {
	e, link, ops := makeTestLink(t, detachedS)
	ops.tabWs[routetest.WindowTabId] = "wsA"
	if _, errStr := routetest.Ask(t, link, e.Window(), molten.DurableSessionsShowCommand, map[string]any{"id": "detached"}); errStr != "" {
		t.Fatal(errStr)
	}
	if !strings.HasPrefix(ops.trace(), "create "+routetest.WindowTabId) {
		t.Fatalf("show from a window opens in its tab: %s", ops.trace())
	}
}

func TestRelevantEvent(t *testing.T) {
	cases := []struct {
		event wps.WaveEvent
		want  bool
	}{
		{wps.WaveEvent{Event: wps.Event_RouteUp, Scopes: []string{"job:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_RouteUp, Scopes: []string{"tab:1"}}, false},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"block:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"workspace:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"layout:1"}}, false},
		{wps.WaveEvent{Event: wps.Event_BlockClose}, true},
	}
	for _, c := range cases {
		if got := relevantEvent(&c.event); got != c.want {
			t.Fatalf("%s %v: got %v", c.event.Event, c.event.Scopes, got)
		}
	}
}
