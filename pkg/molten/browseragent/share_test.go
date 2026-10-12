// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

var userTab = TabKey{PanelId: "p1", BrowserTabId: "user-tab"}

func share(t *testing.T, m *Manager, sessionId string, move bool) ShareResult {
	t.Helper()
	res, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: sessionId, Move: move})
	if err != nil {
		t.Fatalf("share: %v", err)
	}
	return res
}

func sharedEntry(t *testing.T, r mcpbrowser.CallResult) tabEntry {
	t.Helper()
	var parsed struct {
		Tabs []tabEntry `json:"tabs"`
	}
	if err := json.Unmarshal([]byte(strings.SplitN(text(r), "\n", 2)[0]), &parsed); err != nil || len(parsed.Tabs) != 1 {
		t.Fatalf("tabs_context result %q", text(r))
	}
	return parsed.Tabs[0]
}

func TestListSessionsOfThePanelsWorkspace(t *testing.T) {
	m, env, _ := makeWorld(t)
	env.agentNames["term-a"] = "Claude Code"
	hello(t, m, "proc:a-old", "tok-a", "claude-code")
	m.now = func() time.Time { return time.Now().Add(time.Minute) }
	newest := hello(t, m, "proc:a", "tok-a", "claude-code")
	hello(t, m, "proc:c", "tok-c", "codex")
	for _, source := range []string{"proc:a", "", "conn:local"} {
		if _, err := m.ListSessions(context.Background(), source, ListRequest{BlockId: "p1"}); err == nil {
			t.Fatalf("source %q must not list sessions", source)
		}
	}
	res, err := m.ListSessions(context.Background(), "tab:t1", ListRequest{BlockId: "p1"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(res.Sessions) != 1 || res.Sessions[0].SessionId != newest || res.Sessions[0].BlockId != "term-a" || res.Sessions[0].AgentName != "Claude Code" {
		t.Fatalf("only this workspace's agents, the newest session per pane: %+v", res)
	}
}

func TestShareAddsTheTabToTheSessionsScope(t *testing.T) {
	m, env, sink := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "Claude Code")
	if res := share(t, m, sa, false); res.Result != ShareResultShared || res.AgentName != "Claude Code" {
		t.Fatalf("share: %+v", res)
	}
	state, _ := env.lastPublished("p1")
	if len(state.Tabs) != 1 || state.Tabs[0].Origin != OriginShared || state.Tabs[0].AgentName != "Claude Code" || state.Tabs[0].Engaged {
		t.Fatalf("the panel shows the badge, not yet the bar: %+v", state)
	}
	if env.controlled(userTab) {
		t.Fatalf("a shared tab is not under control before the agent acts")
	}
	listed := call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)
	entry := sharedEntry(t, listed)
	if entry.Owner != ownerUser || entry.State != TabStateActive {
		t.Fatalf("the tab is listed as shared by the user: %+v", entry)
	}
	if strings.Contains(text(listed), "SECRET-Q") || strings.Contains(text(listed), "My bank") {
		t.Fatalf("without the site's permission the agent sees the origin only: %s", text(listed))
	}
	if strings.Contains(sink.all(), "SECRET-Q") || strings.Contains(sink.all(), "bank.example/account") {
		t.Fatalf("the log never holds the URL: %s", sink.all())
	}
	if res := share(t, m, sa, false); res.Result != ShareResultShared {
		t.Fatalf("sharing again with the same agent changes nothing: %+v", res)
	}
	if ids := listedIds(t, call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 1 {
		t.Fatalf("one entry per tab: %v", ids)
	}
}

func TestShareRefusals(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	sc := hello(t, m, "proc:c", "tok-c", "c")
	env.addPanel("p2", "t1", "ws1", molten.BrowserPanelTab{Id: "handed", Url: "https://x.example/", Engine: "chrome"})
	for _, tc := range []struct {
		name   string
		source string
		req    ShareRequest
		want   string
	}{
		{"from a terminal", "proc:a", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: sa}, errShareNotUi},
		{"another workspace", "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: sc}, errShareElsewhere},
		{"handed off", "tab:t1", ShareRequest{BlockId: "p2", BrowserTabId: "handed", SessionId: sa}, errShareOtherEngine},
		{"no such tab", "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "nope", SessionId: sa}, errShareTabGone},
		{"no such panel", "tab:t1", ShareRequest{BlockId: "nope", BrowserTabId: "user-tab", SessionId: sa}, errSharePanelUnknown},
		{"no such session", "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: "gone"}, errShareSessionGone},
	} {
		_, err := m.Share(context.Background(), tc.source, tc.req)
		if err == nil || err.Error() != tc.want {
			t.Errorf("%s: want %q, got %v", tc.name, tc.want, err)
		}
	}
	if ids := listedIds(t, call(m, "proc:c", sc, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 0 {
		t.Fatalf("a refused share adds nothing: %v", ids)
	}
}

func TestSharingWithAnotherAgentAsksToMove(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "Claude Code")
	sb := hello(t, m, "proc:b", "tok-b", "Codex")
	share(t, m, sa, false)
	env.sites["bank.example"] = SiteAllow
	if r := call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, `{"tabId":1}`); r.IsError && text(r) == mcpbrowser.ErrNotYourTab {
		t.Fatalf("the first agent can use the tab")
	}
	if !env.controlled(userTab) {
		t.Fatalf("the agent's first call puts the tab under control")
	}
	res := share(t, m, sb, false)
	if res.Result != ShareResultMove || res.Holder != "Claude Code" || res.AgentName != "Codex" {
		t.Fatalf("a tab is shared with one agent at a time: %+v", res)
	}
	if ids := listedIds(t, call(m, "proc:b", sb, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 0 {
		t.Fatalf("nothing moves without the user's agreement: %v", ids)
	}
	if res := share(t, m, sb, true); res.Result != ShareResultShared {
		t.Fatalf("move: %+v", res)
	}
	if env.controlled(userTab) {
		t.Fatalf("the first agent's control ends with the move")
	}
	if ids := listedIds(t, call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 0 {
		t.Fatalf("the tab left the first agent's scope: %v", ids)
	}
	expectError(t, call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, `{"tabId":1}`), mcpbrowser.ErrNotYourTab)
	if entry := sharedEntry(t, call(m, "proc:b", sb, mcpbrowser.ToolTabsContext, `{}`)); entry.Owner != ownerUser {
		t.Fatalf("the second agent has it, shared by the user: %+v", entry)
	}
}

func TestStopSharingRevokesAtOnce(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, sa, false)
	env.sites["bank.example"] = SiteAllow
	tabId := listedIds(t, call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`))[0]
	env.lock.Lock()
	env.cdpBlock = make(chan struct{})
	env.cdpStarted = make(chan struct{}, 4)
	env.lock.Unlock()
	done := make(chan mcpbrowser.CallResult, 1)
	go func() {
		done <- m.Call(context.Background(), "proc:a", mcpbrowser.CallRequest{SessionId: sa, Tool: mcpbrowser.ToolGetPageText, Args: json.RawMessage(fmt.Sprintf(`{"tabId":%d}`, tabId))})
	}()
	select {
	case <-env.cdpStarted:
	case <-time.After(2 * time.Second):
		t.Fatalf("the read never started")
	}
	state, _ := env.lastPublished("p1")
	if len(state.Tabs) != 1 || !state.Tabs[0].Engaged || state.Tabs[0].Action != actionEngaged {
		t.Fatalf("the control bar shows once the agent acts: %+v", state)
	}
	stopAt := time.Now()
	if err := m.Control("tab:t1", ControlRequest{BlockId: "p1", BrowserTabId: "user-tab", Action: ControlStop}); err != nil {
		t.Fatalf("stop sharing: %v", err)
	}
	select {
	case r := <-done:
		if elapsed := time.Since(stopAt); elapsed > 200*time.Millisecond {
			t.Fatalf("stop sharing took %v (NFR-BRW-007: 200 ms)", elapsed)
		}
		if !r.IsError {
			t.Fatalf("the call in flight fails: %s", text(r))
		}
	case <-time.After(time.Second):
		t.Fatalf("the call in flight was not cancelled")
	}
	env.lock.Lock()
	env.cdpBlock = nil
	env.cdpStarted = nil
	env.lock.Unlock()
	if env.controlled(userTab) {
		t.Fatalf("control ends with the share")
	}
	if state, _ := env.lastPublished("p1"); len(state.Tabs) != 0 {
		t.Fatalf("the badge and bar go: %+v", state)
	}
	if ids := listedIds(t, call(m, "proc:a", sa, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 0 {
		t.Fatalf("the tab is gone from tabs_context: %v", ids)
	}
	expectError(t, call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, fmt.Sprintf(`{"tabId":%d}`, tabId)), mcpbrowser.ErrNotYourTab)
	if res := share(t, m, sa, false); res.Result != ShareResultShared {
		t.Fatalf("the tab can be shared again: %+v", res)
	}
}

func TestSharedTabStillAsksTheSitePermission(t *testing.T) {
	m, env, _ := makeWorld(t)
	m.permissionTimeout = 30 * time.Millisecond
	sa := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, sa, false)
	expectError(t, call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, `{"tabId":1}`), mcpbrowser.ErrPermissionTimeout)
	env.sites["bank.example"] = SiteBlock
	expectError(t, call(m, "proc:a", sa, mcpbrowser.ToolGetPageText, `{"tabId":1}`), mcpbrowser.ErrSiteBlocked)
}

func TestShareTellTypesTheLine(t *testing.T) {
	m, env, _ := makeWorld(t)
	sa := hello(t, m, "proc:a", "tok-a", "a")
	tell := func() (ShareTellResult, error) {
		return m.ShareTell(context.Background(), "tab:t1", ShareTellRequest{BlockId: "p1", BrowserTabId: "user-tab"})
	}
	if _, err := tell(); err == nil || err.Error() != errShareNotShared {
		t.Fatalf("a tab shared with nobody has no line: %v", err)
	}
	share(t, m, sa, false)
	if _, err := m.ShareTell(context.Background(), "proc:a", ShareTellRequest{BlockId: "p1", BrowserTabId: "user-tab"}); err == nil {
		t.Fatalf("only a window can ask for the line")
	}
	long := strings.Repeat("é", 90) + "\x1b[201~\r"
	env.setPage("p1", "user-tab", "https://bank.example/account/1?token=SECRET-Q#frag", long)
	res, err := tell()
	if err != nil || !res.Sent {
		t.Fatalf("tell: %+v %v", res, err)
	}
	want := "term-a: I shared the tab \"" + strings.Repeat("é", 79) + "…\" (https://bank.example/account/1) with you."
	if len(env.typed) != 1 || env.typed[0] != want {
		t.Fatalf("typed %q", env.typed)
	}
	env.setPage("p1", "user-tab", "about:blank", "")
	if _, err := tell(); err == nil || err.Error() != errShareNoPage {
		t.Fatalf("an empty tab has no line: %v", err)
	}
	env.setPage("p1", "user-tab", "https://bank.example/", "")
	env.typeRefusal = "a is working"
	if res, err := tell(); err != nil || res.Sent || res.Message != "a is working" {
		t.Fatalf("the terminal's refusal is passed on: %+v %v", res, err)
	}
}

func TestShareLine(t *testing.T) {
	for _, tc := range []struct {
		url, title, want string
	}{
		{"https://github.com/o/r/pull/3?diff=split#c1", "Fix #3", `I shared the tab "Fix #3" (https://github.com/o/r/pull/3) with you.`},
		{"http://localhost:3000", "", `I shared the tab "localhost:3000" (http://localhost:3000/) with you.`},
		{"https://a.example/x", "two\nlines\t here", `I shared the tab "two lines here" (https://a.example/x) with you.`},
	} {
		got, ok := shareLine(molten.BrowserPanelTab{Url: tc.url, Title: tc.title})
		if !ok || got != tc.want {
			t.Errorf("%s: got %q", tc.url, got)
		}
	}
	for _, bad := range []string{"about:blank", "file:///etc/passwd", "javascript:alert(1)", ""} {
		if _, ok := shareLine(molten.BrowserPanelTab{Url: bad, Title: "x"}); ok {
			t.Errorf("%q has no line", bad)
		}
	}
}
