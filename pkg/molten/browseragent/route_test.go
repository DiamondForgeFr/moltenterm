// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func TestRouteStaleStopKeepsReplacementHolder(t *testing.T) {
	m, _, e, link := makeRouteWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	b := hello(t, m, "proc:b", "tok-b", "b")
	share(t, m, a, false)
	if _, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: b, Move: true}); err != nil {
		t.Fatal(err)
	}
	_, errStr := routetest.Ask(t, link, e.Window(), mcpbrowser.ControlCommand, map[string]any{
		"blockid": "p1", "browsertabid": "user-tab", "action": ControlStop, "expectedsessionid": a,
	})
	if errStr == "" {
		t.Fatal("stale stop must report that the holder changed")
	}
	if got := holderOf(m); got != b {
		t.Fatalf("stale stop removed the replacement holder: got %q, want %q", got, b)
	}
}

func TestRouteUndoUsesOriginalSession(t *testing.T) {
	m, _, e, link := makeRouteWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, a, false)
	snapshot, _ := m.PanelSnapshot("tab:t1", "p1")
	if len(snapshot.Tabs) != 1 || snapshot.Tabs[0].SessionId != a {
		t.Fatalf("snapshot must identify the holder: %+v", snapshot)
	}
	_, errStr := routetest.Ask(t, link, e.Window(), mcpbrowser.ControlCommand, map[string]any{
		"blockid": "p1", "browsertabid": "user-tab", "action": ControlStop, "expectedsessionid": a,
	})
	if errStr != "" {
		t.Fatalf("stop: %s", errStr)
	}
	m.Bye("proc:a", a)
	b := hello(t, m, "proc:b", "tok-a", "replacement")
	if b == a {
		t.Fatal("replacement must have a distinct session")
	}
	_, errStr = routetest.Ask(t, link, e.Window(), mcpbrowser.ShareCommand, ShareRequest{
		BlockId: "p1", BrowserTabId: "user-tab", SessionId: a,
	})
	if errStr == "" || holderOf(m) != "" {
		t.Fatalf("undo of ended session must not grant replacement access: error %q holder %q", errStr, holderOf(m))
	}
}

func TestRouteUndoAfterSameSessionReconnect(t *testing.T) {
	m, _, e, link := makeRouteWorld(t)
	m.LinkReported(context.Background(), "term-a", "proc:a1", "molten-browser", 4242, "a")
	a := listed(t, m)["term-a"]
	share(t, m, a, false)
	_, errStr := routetest.Ask(t, link, e.Window(), mcpbrowser.ControlCommand, map[string]any{
		"blockid": "p1", "browsertabid": "user-tab", "action": ControlStop, "expectedsessionid": a,
	})
	if errStr != "" {
		t.Fatalf("stop: %s", errStr)
	}
	m.EndSessionsForRoute("proc:a1")
	m.LinkReported(context.Background(), "term-a", "proc:a2", "molten-browser", 4242, "a")
	if listed(t, m)["term-a"] != a {
		t.Fatal("reconnect did not retain the original session")
	}
	_, errStr = routetest.Ask(t, link, e.Window(), mcpbrowser.ShareCommand, ShareRequest{
		BlockId: "p1", BrowserTabId: "user-tab", SessionId: a,
	})
	if errStr != "" || holderOf(m) != a {
		t.Fatalf("undo after reconnect: error %q holder %q", errStr, holderOf(m))
	}
	snapshot, _ := m.PanelSnapshot("tab:t1", "p1")
	if len(snapshot.Tabs) != 1 || snapshot.Tabs[0].State != TabStateActive || snapshot.Tabs[0].SessionId != a {
		t.Fatalf("restored page must be active: %+v", snapshot)
	}
}

func TestTabForIgnoresEarlierStoppedGrant(t *testing.T) {
	key := TabKey{PanelId: "p1", BrowserTabId: "user-tab"}
	stopped := &agentTab{key: key, state: TabStateStopped}
	active := &agentTab{key: key, state: TabStateActive}
	s := &session{tabs: map[int64]*agentTab{1: stopped}}
	if s.tabFor(key) != nil {
		t.Fatal("a stopped grant is not a current holder")
	}
	s.tabs[2] = active
	if s.tabFor(key) != active {
		t.Fatal("the restored grant must be selected over the stopped one")
	}
}

func makeRouteWorld(t *testing.T) (*Manager, *fakeEnv, *routetest.Env, *localroute.Link) {
	t.Helper()
	m, env, _ := makeWorld(t)
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{manager: m}).route())
	if err != nil {
		t.Fatal(err)
	}
	return m, env, e, link
}

// A takeover sent without asking for an answer: the command runs all the same, and nothing is sent back.
func TestRouteRunsCommandsWithoutReqId(t *testing.T) {
	m, env, e, link := makeRouteWorld(t)
	sid := hello(t, m, e.Terminal().Source, "tok-a", "a")
	createdTabId(t, call(m, e.Terminal().Source, sid, mcpbrowser.ToolTabsCreate, `{}`))
	state, _ := env.lastPublished("p1")
	routetest.Send(t, link, e.Electron(), mcpbrowser.ControlCommand,
		ControlRequest{BlockId: "p1", BrowserTabId: state.Tabs[0].BrowserTabId, Action: ControlTakeOver})
	deadline := time.Now().Add(time.Minute)
	for {
		snapshot, _ := m.PanelSnapshot("tab:t1", "p1")
		if len(snapshot.Tabs) == 1 && snapshot.Tabs[0].State == TabStateTakenOver {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the no-answer takeover never applied: %+v", snapshot)
		}
		time.Sleep(10 * time.Millisecond)
	}
	msg, err := json.Marshal(wshutil.RpcMessage{Command: mcpbrowser.StateCommand, ReqId: "r1", Source: e.Terminal().Source, Data: StateRequest{BlockId: "p1"}})
	if err != nil {
		t.Fatal(err)
	}
	link.SendRpcMessage(msg, e.Terminal().Link, "")
	// The first message out is r1's: the takeover, applied before, sent nothing back.
	out, _ := link.RecvRpcMessage()
	var resp wshutil.RpcMessage
	if err := json.Unmarshal(out, &resp); err != nil || resp.ResId != "r1" || resp.Error == "" {
		t.Fatalf("a terminal reading panel state is refused, and alone answered: %s (%v)", out, err)
	}
}

// #662: a source forged on a link it is not bound to (a remote host's connserver writing "electron", "tab:x" or a
// local terminal's route) is not believed: control is refused, and a session's calls do not reach it.
func TestRouteRefusesForgedSources(t *testing.T) {
	m, env, e, link := makeRouteWorld(t)
	sid := hello(t, m, e.Terminal().Source, "tok-a", "a")
	createdTabId(t, call(m, e.Terminal().Source, sid, mcpbrowser.ToolTabsCreate, `{}`))
	state, _ := env.lastPublished("p1")
	stop := ControlRequest{BlockId: "p1", BrowserTabId: state.Tabs[0].BrowserTabId, Action: ControlStop}
	nonUi := append([]routetest.From{e.Terminal()}, e.Forged()...)
	for _, command := range []string{mcpbrowser.ControlCommand, mcpbrowser.StateCommand, mcpbrowser.AnswerCommand, mcpbrowser.SiteCommand,
		mcpbrowser.DownloadCommand, mcpbrowser.ListCommand, mcpbrowser.ShareCommand, mcpbrowser.ShareTellCommand} {
		routetest.MustRefuse(t, link, nonUi, command, stop)
	}
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	for _, command := range []string{mcpbrowser.HelloCommand, mcpbrowser.CallCommand, mcpbrowser.ByeCommand} {
		routetest.MustRefuseWith(t, link, notTerminals, command, mcpbrowser.CallRequest{SessionId: sid, Tool: mcpbrowser.ToolTabsContext}, mcpbrowser.ErrRemotePane)
	}
	snapshot, _ := m.PanelSnapshot("tab:t1", "p1")
	if len(snapshot.Tabs) != 1 || snapshot.Tabs[0].State != TabStateActive {
		t.Fatalf("the tab must be untouched: %+v", snapshot)
	}
	data, errStr := routetest.Ask(t, link, e.Terminal(), mcpbrowser.CallCommand, mcpbrowser.CallRequest{SessionId: sid, Tool: mcpbrowser.ToolTabsContext})
	var result mcpbrowser.CallResult
	raw, _ := json.Marshal(data)
	if errStr != "" || json.Unmarshal(raw, &result) != nil || result.IsError {
		t.Fatalf("the session's own terminal: %q %s", errStr, raw)
	}
}
