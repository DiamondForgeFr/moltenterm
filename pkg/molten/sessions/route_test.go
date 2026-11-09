// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package sessions

import (
	"sort"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
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
	ops.blockWs[routetest.TerminalBlock] = "wsA"
	return e, link, ops
}

// The terminal asking (routetest.TerminalBlock) is in wsA, its own session ownA; shownB is another workspace's.
// homeA and homeB lost their panes in a tab of wsA and of wsB that still exist; detachedS and paneGoneS lost theirs in a
// tab that is gone (or never recorded).
var (
	ownA    = molten.DurableSession{Id: "own", Shown: true, CanShow: true, CanEnd: true, WorkspaceId: "wsA", TabId: "tabA", BlockId: routetest.TerminalBlock}
	agentA  = molten.DurableSession{Id: "agentA", Shown: true, CanShow: true, CanEnd: true, WorkspaceId: "wsA", TabId: "tabA", BlockId: "blockA", Agent: "claude"}
	agentB  = molten.DurableSession{Id: "agentB", Shown: true, CanShow: true, CanEnd: true, WorkspaceId: "wsB", TabId: "tabB", BlockId: "blockB2", Agent: "claude"}
	homeA   = molten.DurableSession{Id: "homeA", Reason: molten.SessionReasonPaneGone, CanShow: true, CanEnd: true, HomeWorkspaceId: "wsA"}
	homeB   = molten.DurableSession{Id: "homeB", Reason: molten.SessionReasonPaneGone, CanShow: true, CanEnd: true, HomeWorkspaceId: "wsB"}
	scopeOf = []molten.DurableSession{ownA, agentA, shownB, agentB, detachedS, paneGoneS, homeA, homeB}
)

func askList(t *testing.T, link *localroute.Link, from routetest.From) molten.DurableSessionsData {
	t.Helper()
	raw, errStr := routetest.Ask(t, link, from, molten.DurableSessionsListCommand, nil)
	if errStr != "" {
		t.Fatalf("list for %s: %s", from.Name, errStr)
	}
	var data molten.DurableSessionsData
	if err := utilfn.ReUnmarshal(&data, raw); err != nil {
		t.Fatal(err)
	}
	return data
}

func listIds(data molten.DurableSessionsData) string {
	ids := []string{}
	for _, s := range data.Sessions {
		ids = append(ids, s.Id)
	}
	sort.Strings(ids)
	return strings.Join(ids, ",")
}

// AC-1 (#2120): a terminal lists only its workspace's sessions; the windows list every workspace's.
func TestRouteTerminalListsOnlyItsWorkspace(t *testing.T) {
	t.Parallel()
	e, link, _ := makeTestLink(t, scopeOf...)
	got := askList(t, link, e.Terminal())
	if ids := listIds(got); ids != "agentA,homeA,own" {
		t.Fatalf("terminal list: %s", ids)
	}
	if got.WorkspaceId != "wsA" || got.RunningAgents != 1 {
		t.Fatalf("terminal list scope %q, agents %d", got.WorkspaceId, got.RunningAgents)
	}
	full := askList(t, link, e.Window())
	if ids := listIds(full); ids != "agentA,agentB,detached,homeA,homeB,own,panegone,shown" || full.WorkspaceId != "" {
		t.Fatalf("window list: %s scope %q", ids, full.WorkspaceId)
	}
}

// AC-2 (#2120): show, end and reconnect from a terminal refuse another workspace's session, a session no pane shows
// whose workspace is another or unknown (a reattach would copy its history) and a tab of another workspace, naming
// the Sessions panel.
func TestRouteTerminalRefusesOtherWorkspaces(t *testing.T) {
	t.Parallel()
	e, link, ops := makeTestLink(t, scopeOf...)
	cases := []struct {
		command string
		data    map[string]any
		want    string
	}{
		{molten.DurableSessionsShowCommand, map[string]any{"id": "shown", "tabid": "tabA"}, "another workspace"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "detached", "tabid": "tabA"}, "workspace is unknown"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "panegone", "tabid": "tabA"}, "workspace is unknown"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "homeB", "tabid": "tabA"}, "another workspace"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "homeA", "tabid": "tabB"}, "not in this terminal's workspace"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "agentA", "tabid": "tabB"}, "not in this terminal's workspace"},
		{molten.DurableSessionsShowCommand, map[string]any{"id": "agentA", "tabid": "tabnowhere"}, "not in this terminal's workspace"},
		{molten.DurableSessionsEndCommand, map[string]any{"id": "agentB"}, "another workspace"},
		{molten.DurableSessionsEndCommand, map[string]any{"id": "detached"}, "workspace is unknown"},
		{molten.DurableSessionsEndCommand, map[string]any{"id": "homeB"}, "another workspace"},
		{molten.DurableSessionsReconnectCommand, map[string]any{"id": "panegone"}, "workspace is unknown"},
		{molten.DurableSessionsReconnectCommand, map[string]any{"id": "homeB"}, "another workspace"},
		{molten.DurableSessionsReconnectCommand, map[string]any{"id": "shown"}, "another workspace"},
	}
	for _, c := range cases {
		_, errStr := routetest.Ask(t, link, e.Terminal(), c.command, c.data)
		if !strings.Contains(errStr, c.want) || !strings.Contains(errStr, "Sessions panel") {
			t.Fatalf("%s %v from a terminal: %q", c.command, c.data, errStr)
		}
	}
	if len(ops.calls) != 0 {
		t.Fatalf("a refused request acted: %s", ops.trace())
	}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.DurableSessionsShowCommand, map[string]any{"id": "agentA", "tabid": "tabA"}); errStr != "" {
		t.Fatalf("show of its own workspace's session: %s", errStr)
	}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.DurableSessionsEndCommand, map[string]any{"id": "agentA"}); errStr != "" {
		t.Fatalf("end of its own workspace's session: %s", errStr)
	}
	if trace := ops.trace(); trace != "focus tabA blockA; terminate agentA" {
		t.Fatalf("own workspace actions: %s", trace)
	}
}

// A session whose pane is gone from a tab of the terminal's workspace that still exists stays the terminal's: it is
// listed, and `molten session show` reattaches it in the terminal's tab, as end and reconnect still act on it.
func TestRouteTerminalKeepsItsWorkspacesPaneGoneSessions(t *testing.T) {
	t.Parallel()
	e, link, ops := makeTestLink(t, scopeOf...)
	for _, c := range []struct {
		command string
		data    map[string]any
	}{
		{molten.DurableSessionsShowCommand, map[string]any{"id": "homeA", "tabid": "tabA"}},
		{molten.DurableSessionsReconnectCommand, map[string]any{"id": "homeA"}},
		{molten.DurableSessionsEndCommand, map[string]any{"id": "homeA"}},
	} {
		if _, errStr := routetest.Ask(t, link, e.Terminal(), c.command, c.data); errStr != "" {
			t.Fatalf("%s %v from a terminal of its workspace: %s", c.command, c.data, errStr)
		}
	}
	trace := ops.trace()
	for _, want := range []string{"create tabA", "copy homeA newblock", "attach homeA newblock", "reconnect homeA", "terminate+detach homeA"} {
		if !strings.Contains(trace, want) {
			t.Fatalf("own workspace's pane-gone session: %q missing in %s", want, trace)
		}
	}
}

// The windows keep every action on every workspace's sessions (the Sessions panel).
func TestRouteWindowsKeepTheFullView(t *testing.T) {
	t.Parallel()
	e, link, ops := makeTestLink(t, scopeOf...)
	ops.tabWs[routetest.WindowTabId] = "wsA"
	for _, c := range []struct {
		command string
		data    map[string]any
	}{
		{molten.DurableSessionsShowCommand, map[string]any{"id": "detached"}},
		{molten.DurableSessionsEndCommand, map[string]any{"id": "agentB"}},
		{molten.DurableSessionsReconnectCommand, map[string]any{"id": "panegone"}},
	} {
		if _, errStr := routetest.Ask(t, link, e.Window(), c.command, c.data); errStr != "" {
			t.Fatalf("%s %v from a window: %s", c.command, c.data, errStr)
		}
	}
	trace := ops.trace()
	for _, want := range []string{"attach detached newblock", "terminate agentB", "reconnect panegone"} {
		if !strings.Contains(trace, want) {
			t.Fatalf("window actions miss %q: %s", want, trace)
		}
	}
}

// AC-3 (#2120): the self check uses the block the terminal's token names, whatever callerblockid the request carries.
func TestRouteTerminalCannotEndItself(t *testing.T) {
	t.Parallel()
	e, link, ops := makeTestLink(t, scopeOf...)
	for _, data := range []map[string]any{{"id": "own"}, {"id": "own", "callerblockid": "blockA"}, {"id": "own", "callerblockid": ""}} {
		if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.DurableSessionsEndCommand, data); !strings.Contains(errStr, "cannot end itself") {
			t.Fatalf("end %v of the terminal's own session: %q", data, errStr)
		}
	}
	if len(ops.calls) != 0 {
		t.Fatalf("the terminal ended itself: %s", ops.trace())
	}
}

// A terminal whose block is in no workspace reaches no session.
func TestRouteTerminalWithoutWorkspace(t *testing.T) {
	t.Parallel()
	e, link, ops := makeTestLink(t, scopeOf...)
	delete(ops.blockWs, routetest.TerminalBlock)
	for _, command := range []string{molten.DurableSessionsListCommand, molten.DurableSessionsShowCommand, molten.DurableSessionsEndCommand, molten.DurableSessionsReconnectCommand} {
		if _, errStr := routetest.Ask(t, link, e.Terminal(), command, map[string]any{"id": "agentA", "tabid": "tabA"}); !strings.Contains(errStr, "in no workspace") || !strings.Contains(errStr, "Sessions panel") {
			t.Fatalf("%s from a terminal in no workspace: %q", command, errStr)
		}
	}
	if len(ops.calls) != 0 {
		t.Fatalf("a terminal in no workspace acted: %s", ops.trace())
	}
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
