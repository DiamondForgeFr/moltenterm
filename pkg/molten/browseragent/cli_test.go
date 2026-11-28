// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// `molten browser` (#2596): one call of a tool from a terminal's command line, run by the same code as an MCP call. The
// pages are synthetic (example hosts) and no agent CLI is started.

func cliCaller(blockId string) localroute.Caller {
	return localroute.Caller{Source: "proc:cli-" + blockId, IsLocalTerminal: true, BlockId: blockId}
}

func cliCall(m *Manager, blockId string, token string, tool string, args string) mcpbrowser.CallResult {
	return m.CliCall(context.Background(), cliCaller(blockId), mcpbrowser.CliRequest{Token: token, Tool: tool, Args: json.RawMessage(args)})
}

func cliWorld(t *testing.T) (*Manager, *fakeEnv, *fakePage) {
	t.Helper()
	m, env, _ := makeWorld(t)
	page := makeFakePage()
	page.text = "The guide says hello."
	page.titles["https://docs.example/guide"] = "The guide"
	env.cdpFn = page.cdp
	env.SetAgentSite("docs.example", SiteAllow)
	return m, env, page
}

func (w *cliTerm) call(tool string, args string) mcpbrowser.CallResult {
	return cliCall(w.m, w.blockId, w.token, tool, args)
}

// cliTerm is one terminal's command line.
type cliTerm struct {
	m       *Manager
	blockId string
	token   string
}

func sessionsOf(m *Manager, blockId string) []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []string
	for _, s := range m.sessions {
		if s.blockId == blockId {
			rtn = append(rtn, s.source)
		}
	}
	return rtn
}

func contextOf(t *testing.T, r mcpbrowser.CallResult) mcpbrowser.ContextData {
	t.Helper()
	if r.IsError {
		t.Fatalf("tabs_context: %s", text(r))
	}
	var data mcpbrowser.ContextData
	if err := json.Unmarshal(r.Data, &data); err != nil {
		t.Fatalf("tabs_context has no data for the command line: %v %q", err, r.Data)
	}
	return data
}

func TestCliCallTakesTheTerminalFromItsOwnToken(t *testing.T) {
	m, env, _ := cliWorld(t)
	env.blocks["term-r"] = BlockLocation{TabId: "t1", WorkspaceId: "ws1", View: TermView, Local: false}
	cases := []struct {
		name   string
		caller localroute.Caller
		token  string
		want   string
	}{
		{"no token", cliCaller("term-a"), "", mcpbrowser.ErrNotInMoltenTerm},
		{"a forged token", cliCaller("term-a"), "forged", mcpbrowser.ErrNotInMoltenTerm},
		{"the token of a page, not a terminal", cliCaller("term-a"), "tok-web", mcpbrowser.ErrNotInMoltenTerm},
		{"another terminal's token on this link", cliCaller("term-b"), "tok-a", mcpbrowser.ErrNotInMoltenTerm},
		{"a caller that is not a local terminal", localroute.Caller{Source: "proc:x", BlockId: "term-a"}, "tok-a", mcpbrowser.ErrNotInMoltenTerm},
		{"a terminal over SSH or WSL", cliCaller("term-r"), "tok-r", mcpbrowser.ErrRemotePane},
	}
	for _, c := range cases {
		r := m.CliCall(context.Background(), c.caller, mcpbrowser.CliRequest{Token: c.token, Tool: mcpbrowser.ToolTabsContext, Args: json.RawMessage(`{}`)})
		if !r.IsError || text(r) != c.want {
			t.Errorf("%s: want %q, got %q", c.name, c.want, text(r))
		}
	}
	if len(m.sessions) != 0 {
		t.Fatalf("a refused call opens no session: %v", m.sessions)
	}
}

func TestCliCallRunsOnlyTheToolsWithACommand(t *testing.T) {
	m, _, _ := cliWorld(t)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	for _, tool := range []string{mcpbrowser.ToolComputer, mcpbrowser.ToolNavigate, mcpbrowser.ToolBatch, mcpbrowser.ToolFormInput,
		mcpbrowser.ToolListAgents, "unknown", ""} {
		expectError(t, term.call(tool, `{}`), mcpbrowser.ErrUnknownTool)
	}
	if len(m.sessions) != 0 {
		t.Fatalf("a refused tool opens no session")
	}
}

func TestCliSessionKeepsItsTabsFromOneCommandToTheNext(t *testing.T) {
	m, env, _ := cliWorld(t)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	env.agentNames["term-a"] = "Kimi Code"
	opened := term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide"}`)
	tab := createdTabId(t, opened)
	if !strings.Contains(text(opened), "opened tab") {
		t.Fatalf("open: %s", text(opened))
	}
	listed := contextOf(t, term.call(mcpbrowser.ToolTabsContext, `{}`))
	if len(listed.Tabs) != 1 || listed.Tabs[0].TabId != tab || listed.Tabs[0].Owner != "you" || listed.Tabs[0].State != mcpbrowser.TabStateActive {
		t.Fatalf("the next command finds the tab: %+v", listed)
	}
	if listed.Tabs[0].Url != "https://docs.example/guide" || listed.Tabs[0].Title != "The guide" {
		t.Fatalf("the listing carries the page's address and title for the command line: %+v", listed.Tabs[0])
	}
	read := term.call(mcpbrowser.ToolGetPageText, fmt.Sprintf(`{"tabId":%d}`, tab))
	if read.IsError || !strings.Contains(text(read), "The guide says hello.") || !strings.Contains(text(read), mcpbrowser.UntrustedNotice) ||
		!strings.Contains(text(read), "<untrusted-page-content") {
		t.Fatalf("read: the page comes back inside the notice: %s", text(read))
	}
	if shown := term.call(mcpbrowser.ToolTabsShow, fmt.Sprintf(`{"tabId":%d}`, tab)); shown.IsError || !strings.Contains(text(shown), `"shown":true`) {
		t.Fatalf("show: %s", text(shown))
	}
	if closed := term.call(mcpbrowser.ToolTabsClose, fmt.Sprintf(`{"tabId":%d}`, tab)); closed.IsError {
		t.Fatalf("close: %s", text(closed))
	}
	if left := contextOf(t, term.call(mcpbrowser.ToolTabsContext, `{}`)); len(left.Tabs) != 0 {
		t.Fatalf("closed: %+v", left)
	}
	if sources := sessionsOf(m, "term-a"); len(sources) != 1 || sources[0] != cliSource("term-a") {
		t.Fatalf("one session for the terminal's commands: %v", sources)
	}
	m.lock.Lock()
	name := ""
	for _, s := range m.sessions {
		name = s.agentName
	}
	m.lock.Unlock()
	if name != "Kimi Code" {
		t.Fatalf("the bar names the terminal's detected agent, whatever the agent CLI: %q", name)
	}
}

func TestCliOpenReusesThePageItHolds(t *testing.T) {
	m, _, _ := cliWorld(t)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	first := createdTabId(t, term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide"}`))
	again := term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide"}`)
	if again.IsError || !strings.Contains(text(again), fmt.Sprintf("reused tab %d", first)) {
		t.Fatalf("the same address twice reuses the tab, as the MCP tool does: %s", text(again))
	}
	other := term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide","newTab":true}`)
	if second := createdTabId(t, other); second == first || !strings.Contains(text(other), "opened tab") {
		t.Fatalf("newTab opens another: %s", text(other))
	}
}

func TestCliCallAsksTheSameSiteQuestionsAsTheMcpTools(t *testing.T) {
	m, env, _ := cliWorld(t)
	env.SetAgentSite("blocked.example", SiteBlock)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	expectError(t, term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://blocked.example/"}`), mcpbrowser.ErrSiteBlocked)
	expectError(t, term.call(mcpbrowser.ToolTabsCreate, `{"url":"file:///etc/passwd"}`), mcpbrowser.ErrSchemeRefused)
	expectError(t, term.call(mcpbrowser.ToolTabsCreate, `{"url":"javascript:alert(1)"}`), mcpbrowser.ErrSchemeRefused)
	expectError(t, term.call(mcpbrowser.ToolGetPageText, `{"tabId":99}`), mcpbrowser.ErrNotYourTab)
	expectError(t, term.call(mcpbrowser.ToolTabsShow, `{}`), mcpbrowser.ErrTabIdRequired)
}

func TestCliCallScopesTabsToItsTerminal(t *testing.T) {
	m, _, _ := cliWorld(t)
	a := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	b := &cliTerm{m: m, blockId: "term-b", token: "tok-b"}
	tab := createdTabId(t, a.call(mcpbrowser.ToolTabsCreate, `{}`))
	expectError(t, b.call(mcpbrowser.ToolTabsShow, fmt.Sprintf(`{"tabId":%d}`, tab)), mcpbrowser.ErrNotYourTab)
	expectError(t, b.call(mcpbrowser.ToolTabsClose, fmt.Sprintf(`{"tabId":%d}`, tab)), mcpbrowser.ErrNotYourTab)
	if listed := contextOf(t, b.call(mcpbrowser.ToolTabsContext, `{}`)); len(listed.Tabs) != 0 {
		t.Fatalf("another terminal's tab is not listed: %+v", listed)
	}
	if len(sessionsOf(m, "term-a")) != 1 || len(sessionsOf(m, "term-b")) != 1 {
		t.Fatalf("one session per terminal")
	}
}

func TestCliAndMcpServerShareOneSession(t *testing.T) {
	m, _, _ := cliWorld(t)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	fromCli := createdTabId(t, term.call(mcpbrowser.ToolTabsCreate, `{}`))
	sid := hello(t, m, "proc:mcp", "tok-a", "claude-code")
	if sources := sessionsOf(m, "term-a"); len(sources) != 1 || sources[0] != "proc:mcp" {
		t.Fatalf("the server takes over the session the commands opened: %v", sources)
	}
	if ids := listedIds(t, call(m, "proc:mcp", sid, mcpbrowser.ToolTabsContext, `{}`)); len(ids) != 1 || ids[0] != fromCli {
		t.Fatalf("the agent's tools see the tab its commands opened: %v", ids)
	}
	fromMcp := createdTabId(t, call(m, "proc:mcp", sid, mcpbrowser.ToolTabsCreate, `{}`))
	listed := contextOf(t, term.call(mcpbrowser.ToolTabsContext, `{}`))
	if len(listed.Tabs) != 2 || listed.Tabs[0].TabId != fromCli || listed.Tabs[1].TabId != fromMcp {
		t.Fatalf("the commands see the tabs of the server's session: %+v", listed)
	}
	if len(sessionsOf(m, "term-a")) != 1 {
		t.Fatalf("the commands joined the server's session, they opened none: %v", sessionsOf(m, "term-a"))
	}
	m.EndSessionsForRoute("proc:mcp")
	if listed := contextOf(t, term.call(mcpbrowser.ToolTabsContext, `{}`)); len(listed.Tabs) != 0 {
		t.Fatalf("the server went: its tabs are the developer's, and the commands start a session of their own: %+v", listed)
	}
	if sources := sessionsOf(m, "term-a"); len(sources) != 1 || sources[0] != cliSource("term-a") {
		t.Fatalf("a new session of the commands: %v", sources)
	}
}

func TestCliCommandsJoinAServerSessionThatIsAlreadyThere(t *testing.T) {
	m, _, _ := cliWorld(t)
	sid := hello(t, m, "proc:mcp", "tok-a", "codex")
	tab := createdTabId(t, call(m, "proc:mcp", sid, mcpbrowser.ToolTabsCreate, `{}`))
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	if shown := term.call(mcpbrowser.ToolTabsShow, fmt.Sprintf(`{"tabId":%d}`, tab)); shown.IsError {
		t.Fatalf("a command acts on the tab the server's tool opened: %s", text(shown))
	}
	if sources := sessionsOf(m, "term-a"); len(sources) != 1 || sources[0] != "proc:mcp" {
		t.Fatalf("no second session: %v", sources)
	}
}

func TestCliCallIsRefusedWhileTheDeveloperStoppedTheBrowserServer(t *testing.T) {
	m, _, _ := cliWorld(t)
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	tab := createdTabId(t, term.call(mcpbrowser.ToolTabsCreate, `{}`))
	stopped := true
	gated := []string{}
	original := cliGate
	t.Cleanup(func() { cliGate = original })
	cliGate = func(blockId string, server string) error {
		gated = append(gated, blockId+"/"+server)
		if stopped {
			return errors.New(agentlinkwire.ErrStopped)
		}
		return nil
	}
	expectError(t, term.call(mcpbrowser.ToolTabsContext, `{}`), agentlinkwire.ErrStopped)
	expectError(t, term.call(mcpbrowser.ToolGetPageText, fmt.Sprintf(`{"tabId":%d}`, tab)), agentlinkwire.ErrStopped)
	if len(gated) != 2 || gated[0] != "term-a/"+agentlinkwire.ServerBrowser {
		t.Fatalf("the stop of the terminal's browser server is what is asked: %v", gated)
	}
	if len(sessionsOf(m, "term-a")) != 0 {
		t.Fatalf("a stop ends the tabs the commands hold, as it does the server's: %v", sessionsOf(m, "term-a"))
	}
	stopped = false
	if listed := contextOf(t, term.call(mcpbrowser.ToolTabsContext, `{}`)); len(listed.Tabs) != 0 {
		t.Fatalf("after Reconnect the commands answer, with a new session: %+v", listed)
	}
}

func TestSweepEndsTheCommandSessionsOfClosedTerminalsOnly(t *testing.T) {
	m, env, _ := cliWorld(t)
	a := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	b := &cliTerm{m: m, blockId: "term-b", token: "tok-b"}
	createdTabId(t, a.call(mcpbrowser.ToolTabsCreate, `{}`))
	createdTabId(t, b.call(mcpbrowser.ToolTabsCreate, `{}`))
	sid := hello(t, m, "proc:mcp-c", "tok-c", "claude-code")
	createdTabId(t, call(m, "proc:mcp-c", sid, mcpbrowser.ToolTabsCreate, `{}`))
	m.sweepCliSessions(context.Background())
	if len(m.sessions) != 3 {
		t.Fatalf("every terminal is still there: %d sessions", len(m.sessions))
	}
	env.lock.Lock()
	delete(env.blocks, "term-a")
	delete(env.blocks, "term-c")
	env.lock.Unlock()
	m.sweepCliSessions(context.Background())
	if len(sessionsOf(m, "term-a")) != 0 {
		t.Fatalf("the closed terminal's command session is forgotten: %v", sessionsOf(m, "term-a"))
	}
	if len(sessionsOf(m, "term-b")) != 1 {
		t.Fatalf("the open terminal's stays")
	}
	if len(sessionsOf(m, "term-c")) != 1 {
		t.Fatalf("a server's session ends with its route, not here")
	}
}

// The command line's call goes over the route like the server's, with the terminal's own leaf and token: the policy
// refuses everything that is not a local terminal, and a terminal cannot speak for another one.
func TestRouteAnswersTheCommandLineFromItsOwnTerminalOnly(t *testing.T) {
	m, env, e, link := makeRouteWorld(t)
	env.tokens["tok-local"] = routetest.TerminalBlock
	env.addBlock(routetest.TerminalBlock, "t1", "ws1", TermView)
	req := mcpbrowser.CliRequest{Token: "tok-local", Tool: mcpbrowser.ToolTabsCreate, Args: json.RawMessage(`{}`)}

	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notTerminals, mcpbrowser.CliCommand, req, mcpbrowser.ErrRemotePane)
	if len(m.sessions) != 0 {
		t.Fatalf("a refused caller opens no session")
	}

	answer := func(from routetest.From, req mcpbrowser.CliRequest) mcpbrowser.CallResult {
		t.Helper()
		data, errStr := routetest.Ask(t, link, from, mcpbrowser.CliCommand, req)
		if errStr != "" {
			t.Fatalf("%s: %s", from.Name, errStr)
		}
		var result mcpbrowser.CallResult
		raw, _ := json.Marshal(data)
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatalf("%s: %v %s", from.Name, err, raw)
		}
		return result
	}
	opened := answer(e.Terminal(), req)
	tab := createdTabId(t, opened)
	req.Tool = mcpbrowser.ToolTabsContext
	listed := contextOf(t, answer(e.Terminal(), req))
	if len(listed.Tabs) != 1 || listed.Tabs[0].TabId != tab {
		t.Fatalf("the terminal's own commands find their tab, and the listing's data crosses the wire: %+v", listed)
	}
	if sources := sessionsOf(m, routetest.TerminalBlock); len(sources) != 1 || sources[0] != cliSource(routetest.TerminalBlock) {
		t.Fatalf("one session for the terminal's commands: %v", sources)
	}

	req.Token = "tok-a"
	expectError(t, answer(e.Terminal(), req), mcpbrowser.ErrNotInMoltenTerm)
	if len(sessionsOf(m, "term-a")) != 0 {
		t.Fatalf("a terminal cannot open a session for another one")
	}
}

func TestCliCallsAreLoggedLikeAnyToolCall(t *testing.T) {
	m, _, _ := cliWorld(t)
	sink := &logSink{}
	m.logf = sink.logf
	term := &cliTerm{m: m, blockId: "term-a", token: "tok-a"}
	createdTabId(t, term.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide?q=PLANTED-QUERY"}`))
	logs := sink.all()
	for _, want := range []string{"started by molten browser", "tool=tabs_create", "site=docs.example"} {
		if !strings.Contains(logs, want) {
			t.Errorf("the log misses %q:\n%s", want, logs)
		}
	}
	if strings.Contains(logs, "PLANTED-QUERY") || strings.Contains(logs, "tok-a") {
		t.Fatalf("the log holds an address or a token:\n%s", logs)
	}
}
