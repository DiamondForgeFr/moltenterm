// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Reusing a page that is already open (#2333). The pages are synthetic: example hosts, no real site, no agent CLI. The
// waits end on a signal (the ask appears, the answer is given, the call returns), never on how long anything takes.

const (
	guideUrl = "https://docs.example/guide"
	waitFor  = 30 * time.Second
)

// reuseWorld: workspace ws1 has the agent's Wave tab t1 (panel p1 holds the user's bank page, p2 the user's guide page,
// p3 the same guide page written another way) and a second Wave tab t3 (panel p4 shows the guide too); workspace ws2
// has a panel p5 that shows the guide as well. Each of the agent's tabs gets a page of its own.
type reuseWorld struct {
	m     *Manager
	env   *fakeEnv
	sink  *logSink
	sid   string
	lock  sync.Mutex
	pages map[TabKey]*fakePage
}

func (w *reuseWorld) pageFor(key TabKey) *fakePage {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.pages[key] == nil {
		w.pages[key] = makeFakePage()
	}
	return w.pages[key]
}

func makeReuseWorld(t *testing.T) *reuseWorld {
	t.Helper()
	m, env, sink := makeWorld(t)
	m.permissionTimeout = time.Minute
	m.permissionPoll = 5 * time.Millisecond
	m.reuseTimeout = time.Minute
	w := &reuseWorld{m: m, env: env, sink: sink, pages: map[TabKey]*fakePage{}}
	env.cdpFn = func(key TabKey, method string, params any) (json.RawMessage, error) {
		return w.pageFor(key).cdp(key, method, params)
	}
	env.addPanel("p2", "t1", "ws1", molten.BrowserPanelTab{Id: "docs-tab", Url: guideUrl, Title: "The guide"})
	env.addPanel("p3", "t1", "ws1", molten.BrowserPanelTab{Id: "docs-tab-2", Url: "HTTPS://DOCS.example:443/guide/#intro", Title: "The guide again"})
	env.addPanel("p4", "t3", "ws1", molten.BrowserPanelTab{Id: "review-tab", Url: guideUrl, Title: "Guide in the other tab"})
	env.addPanel("p5", "t2", "ws2", molten.BrowserPanelTab{Id: "elsewhere-tab", Url: guideUrl, Title: "Guide in another workspace"})
	env.tabNames["t1"] = "Main"
	env.tabNames["t3"] = "Review"
	env.shownTabs["ws1"] = "t1"
	env.SetAgentSite("docs.example", SiteAllow)
	w.sid = hello(t, m, "proc:a", "tok-a", "claude-code")
	return w
}

func (w *reuseWorld) call(tool string, args string) mcpbrowser.CallResult {
	return call(w.m, "proc:a", w.sid, tool, args)
}

func (w *reuseWorld) callAsync(tool string, args string) chan mcpbrowser.CallResult {
	ch := make(chan mcpbrowser.CallResult, 1)
	go func() { ch <- w.call(tool, args) }()
	return ch
}

func (w *reuseWorld) create(url string, extra string) mcpbrowser.CallResult {
	args := fmt.Sprintf(`{"url":%q`, url)
	if extra != "" {
		args += "," + extra
	}
	return w.call(mcpbrowser.ToolTabsCreate, args+"}")
}

func (w *reuseWorld) waitAsk(t *testing.T, panelId string) PanelReuseAsk {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for time.Now().Before(deadline) {
		if asks := w.m.panelState(panelId).Asks; len(asks) > 0 {
			return asks[0]
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("no question was asked on panel %s", panelId)
	return PanelReuseAsk{}
}

func (w *reuseWorld) answer(t *testing.T, panelId string, ask PanelReuseAsk, decision string) {
	t.Helper()
	err := w.m.Answer(wshutil.ElectronRoute, AnswerRequest{BlockId: panelId, BrowserTabId: ask.BrowserTabId, RequestId: ask.RequestId, Decision: decision})
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
}

func (w *reuseWorld) result(t *testing.T, ch chan mcpbrowser.CallResult) mcpbrowser.CallResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(waitFor):
		t.Fatalf("the call did not return")
	}
	return mcpbrowser.CallResult{}
}

func (w *reuseWorld) otherAsksEmpty(t *testing.T) {
	t.Helper()
	for _, panelId := range []string{"p1", "p2", "p3", "p4", "p5"} {
		if asks := w.m.panelState(panelId).Asks; len(asks) != 0 {
			t.Fatalf("no question is expected on %s: %+v", panelId, asks)
		}
	}
}

type contextView struct {
	Tabs       []tabEntry  `json:"tabs"`
	OtherPages []pageEntry `json:"otherPages"`
}

func parseContext(t *testing.T, r mcpbrowser.CallResult) contextView {
	t.Helper()
	if r.IsError {
		t.Fatalf("tabs_context: %s", text(r))
	}
	var view contextView
	if err := json.Unmarshal([]byte(strings.SplitN(text(r), "\n", 2)[0]), &view); err != nil {
		t.Fatalf("tabs_context result %q", text(r))
	}
	return view
}

func resultTabId(t *testing.T, r mcpbrowser.CallResult) int64 {
	t.Helper()
	return createdTabId(t, r)
}

func (w *reuseWorld) tabCount() int {
	n := 0
	for _, wp := range mustPanels(w.env) {
		n += len(wp.Tabs)
	}
	return n
}

func mustPanels(env *fakeEnv) []WorkspacePanel {
	var all []WorkspacePanel
	for _, ws := range []string{"ws1", "ws2"} {
		panels, _ := env.WorkspacePanels(context.Background(), ws)
		all = append(all, panels...)
	}
	return all
}

func TestNoUrlStillOpensAnEmptyTab(t *testing.T) {
	w := makeReuseWorld(t)
	before := w.tabCount()
	r := w.call(mcpbrowser.ToolTabsCreate, `{}`)
	resultTabId(t, r)
	if !strings.Contains(text(r), "Opened an empty tab") || w.tabCount() != before+1 {
		t.Fatalf("a call without a url opens an empty tab as it always did: %s", text(r))
	}
	w.otherAsksEmpty(t)
}

func TestACallWithAnAddressOpensItAndAnotherCallReusesIt(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	opened := w.call(mcpbrowser.ToolTabsCreate, `{"url":"mine.example/page#top"}`)
	tabId := resultTabId(t, opened)
	if !strings.Contains(text(opened), "opened tab") || strings.Contains(text(opened), "reused tab") || !strings.Contains(text(opened), `"reused":false`) {
		t.Fatalf("the agent learns the tab was opened: %s", text(opened))
	}
	key := TabKey{}
	if info, ok := w.m.tab(w.sid, tabId); ok {
		key = info.key
	}
	if got := w.pageFor(key).current(); got != "https://mine.example/page#top" {
		t.Fatalf("the address loaded in the new tab: %q", got)
	}
	count := w.tabCount()
	shown := shownTsOf(t, w.m, key)
	for _, again := range []string{"https://MINE.example/page", "mine.example:443/page/", "https://mine.example/page#elsewhere"} {
		r := w.create(again, "")
		if id := resultTabId(t, r); id != tabId || !strings.Contains(text(r), "reused tab") || !strings.Contains(text(r), `"reused":true`) || strings.Contains(text(r), "opened tab") {
			t.Fatalf("%s must reuse tab %d: %s", again, tabId, text(r))
		}
		if w.tabCount() != count {
			t.Fatalf("a reused page opens no tab: %d tabs, were %d", w.tabCount(), count)
		}
	}
	if got := shownTsOf(t, w.m, key); got <= shown {
		t.Fatalf("a reused tab is shown to the developer again: shownts %d, was %d", got, shown)
	}
	if calls := w.pageFor(key).calls(opNavigate); calls != 1 {
		t.Fatalf("reusing a tab loads nothing again: %d loads", calls)
	}
}

func TestAnotherQueryIsAnotherPage(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	first := resultTabId(t, w.create("https://mine.example/search?q=a", ""))
	second := resultTabId(t, w.create("https://mine.example/search?q=b", ""))
	if first == second {
		t.Fatalf("a different query is a different page")
	}
}

func TestReloadAsksForAFreshCopyOfAReusedTab(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page", ""))
	info, _ := w.m.tab(w.sid, tabId)
	page := w.pageFor(info.key)
	r := w.create("https://mine.example/page", `"reload":true`)
	if resultTabId(t, r) != tabId || !strings.Contains(text(r), "reused tab") || !strings.Contains(text(r), "loaded again") {
		t.Fatalf("a reused tab is loaded again on request: %s", text(r))
	}
	if page.calls(opNavigate) != 2 {
		t.Fatalf("the page is loaded a second time: %d loads", page.calls(opNavigate))
	}
	page.lock.Lock()
	last := page.navParams[len(page.navParams)-1]
	page.lock.Unlock()
	if last["url"] != "https://mine.example/page" {
		t.Fatalf("the reload loads the page the tab shows: %v", last)
	}
}

func TestNewTabOpensASecondCopyOnPurpose(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	first := resultTabId(t, w.create("https://mine.example/page", ""))
	count := w.tabCount()
	r := w.create("https://mine.example/page", `"newTab":true`)
	second := resultTabId(t, r)
	if second == first || !strings.Contains(text(r), "opened tab") || w.tabCount() != count+1 {
		t.Fatalf("newTab opens another copy: %s", text(r))
	}
	if r := w.create("https://mine.example/page", ""); resultTabId(t, r) != second {
		t.Fatalf("of two copies the newest is the one reused: %s", text(r))
	}
}

func TestNavigateToTheSameAddressOrReloadLoadsTheTabAgain(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page", ""))
	info, _ := w.m.tab(w.sid, tabId)
	page := w.pageFor(info.key)
	args := func(url string) string { return fmt.Sprintf(`{"tabId":%d,"url":%q}`, tabId, url) }
	if r := w.call(mcpbrowser.ToolNavigate, args("https://mine.example/page")); r.IsError {
		t.Fatalf("navigate: %s", text(r))
	}
	if r := w.call(mcpbrowser.ToolNavigate, args("reload")); r.IsError || !strings.Contains(text(r), "mine.example") {
		t.Fatalf("reload: %s", text(r))
	}
	if page.calls(opNavigate) != 3 || page.current() != "https://mine.example/page" {
		t.Fatalf("both loaded the same page in place: %d loads, at %q", page.calls(opNavigate), page.current())
	}
	if published := publishedAgentTab(t, w.env, info.key); published.Action != actionReload || published.ActionText == nil || published.ActionText.Code != "browser.action.reload" {
		t.Fatalf("the bar says the page was loaded again, coded for the window: %+v", published)
	}
	empty := resultTabId(t, w.call(mcpbrowser.ToolTabsCreate, `{}`))
	expectError(t, w.call(mcpbrowser.ToolNavigate, fmt.Sprintf(`{"tabId":%d,"url":"reload"}`, empty)), mcpbrowser.ErrNothingToReload)
}

func TestReloadedTabStillNeedsItsSite(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page", ""))
	w.env.SetAgentSite("mine.example", SiteBlock)
	expectError(t, w.call(mcpbrowser.ToolNavigate, fmt.Sprintf(`{"tabId":%d,"url":"reload"}`, tabId)), mcpbrowser.ErrSiteBlocked)
	info, _ := w.m.tab(w.sid, tabId)
	page := w.pageFor(info.key)
	loads := page.calls(opNavigate)
	r := w.create("https://mine.example/page", `"reload":true`)
	if !r.IsError || page.calls(opNavigate) != loads {
		t.Fatalf("a blocked site is not loaded again: %s", text(r))
	}
	if !strings.Contains(text(r), "reused tab") && !strings.Contains(text(r), "shown but not loaded again") {
		t.Fatalf("the agent is told the tab was reused and not loaded: %s", text(r))
	}
}

func TestAnAddressThatIsNotAWebPageIsRefused(t *testing.T) {
	w := makeReuseWorld(t)
	count := w.tabCount()
	for _, url := range []string{"file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "https://user:secret@docs.example/guide"} {
		expectError(t, w.create(url, ""), mcpbrowser.ErrSchemeRefused)
	}
	if w.tabCount() != count {
		t.Fatalf("a refused address opens nothing")
	}
}

func TestAskTheDeveloperBeforeUsingTheirPageAndAllowSharesIt(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	w.env.recent["p3"] = 1
	count := w.tabCount()
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, "https://DOCS.example/guide/#top"))
	ask := w.waitAsk(t, "p2")
	if ask.BrowserTabId != "docs-tab" || ask.AgentName != "claude-code" || ask.RequestId == "" {
		t.Fatalf("the question names the page and the agent: %+v", ask)
	}
	w.otherAsksEmpty2(t, "p2")
	if state := w.m.panelState("p2"); len(state.Tabs) != 0 {
		t.Fatalf("nothing is taken before the answer: %+v", state.Tabs)
	}
	if owner, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
		t.Fatalf("the developer's tab is still theirs: held by %v", owner)
	}
	select {
	case r := <-pending:
		t.Fatalf("the call waits for the developer: %s", text(r))
	default:
	}
	if state, ok := w.env.lastPublished("p2"); !ok || len(state.Asks) != 1 {
		t.Fatalf("the panel is told of the question: %+v", state)
	}
	w.answer(t, "p2", ask, DecisionAllow)
	r := w.result(t, pending)
	tabId := resultTabId(t, r)
	if !strings.Contains(text(r), "reused tab") || !strings.Contains(text(r), "let you use it") || strings.Contains(text(r), "The user shared tab") {
		t.Fatalf("the agent is told it got the tab, once: %s", text(r))
	}
	if w.tabCount() != count {
		t.Fatalf("no new tab was opened")
	}
	info, ok := w.m.tab(w.sid, tabId)
	if !ok || info.key != (TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}) || info.origin != OriginShared || info.state != TabStateActive {
		t.Fatalf("Allow shares the tab as Share does: %+v", info)
	}
	state := w.m.panelState("p2")
	if len(state.Tabs) != 1 || state.Tabs[0].Origin != OriginShared || !state.Tabs[0].Engaged || len(state.Asks) != 0 {
		t.Fatalf("the tab is the agent's, with its bar, and the question is gone: %+v", state)
	}
	if !w.env.controlled(info.key) {
		t.Fatalf("emain is told the tab is driven")
	}
	listed := parseContext(t, w.call(mcpbrowser.ToolTabsContext, `{}`))
	if len(listed.Tabs) != 1 || listed.Tabs[0].Owner != ownerUser || listed.Tabs[0].TabId != tabId {
		t.Fatalf("tabs_context lists the shared tab as the user's: %+v", listed.Tabs)
	}
	if again := w.call(mcpbrowser.ToolTabsContext, `{}`); strings.Contains(text(again), "The user shared tab") {
		t.Fatalf("no separate share notice follows: %s", text(again))
	}
}

// otherAsksEmpty2 checks that no question is on a panel other than the named one.
func (w *reuseWorld) otherAsksEmpty2(t *testing.T, except string) {
	t.Helper()
	for _, panelId := range []string{"p1", "p2", "p3", "p4", "p5"} {
		if panelId == except {
			continue
		}
		if asks := w.m.panelState(panelId).Asks; len(asks) != 0 {
			t.Fatalf("no question is expected on %s: %+v", panelId, asks)
		}
	}
}

func TestSeveralMatchesAskOnTheOneInViewThenTheMostRecent(t *testing.T) {
	w := makeReuseWorld(t)
	// p2's page was used last, but p3's is the one in view (p2 shows another page of its own).
	w.env.recent["p2"] = 0
	w.env.recent["p3"] = 3
	w.env.active["p2"] = "another-page"
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p3")
	if ask.BrowserTabId != "docs-tab-2" {
		t.Fatalf("the page in view is asked about first: %+v", ask)
	}
	w.otherAsksEmpty2(t, "p3")
	w.answer(t, "p3", ask, DecisionDeny)
	w.result(t, pending)
}

func TestWhenBothAreInViewTheMostRecentlyUsedPageIsAskedAbout(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	w.env.recent["p3"] = 3
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p2")
	if ask.BrowserTabId != "docs-tab" {
		t.Fatalf("the most recently used page is asked about: %+v", ask)
	}
	w.otherAsksEmpty2(t, "p2")
	w.answer(t, "p2", ask, DecisionDeny)
	w.result(t, pending)
}

func TestTheAgentsOwnTabComesBeforeTheDevelopersPage(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	w.env.shownTabs["ws1"] = "t1"
	opened := w.call(mcpbrowser.ToolTabsCreate, `{"url":"https://docs.example/guide","newTab":true}`)
	tabId := resultTabId(t, opened)
	r := w.create(guideUrl, "")
	if resultTabId(t, r) != tabId || !strings.Contains(text(r), "reused tab") {
		t.Fatalf("the agent's own tab is reused without asking the developer: %s", text(r))
	}
	w.otherAsksEmpty(t)
}

func TestOpenAnotherTabLeavesTheDevelopersPageAlone(t *testing.T) {
	for _, decision := range []string{DecisionDeny, DecisionDismiss} {
		t.Run(decision, func(t *testing.T) {
			w := makeReuseWorld(t)
			w.env.recent["p2"] = 0
			count := w.tabCount()
			pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
			ask := w.waitAsk(t, "p2")
			w.answer(t, "p2", ask, decision)
			r := w.result(t, pending)
			tabId := resultTabId(t, r)
			if !strings.Contains(text(r), "opened tab") || !strings.Contains(text(r), "kept their own tab") || strings.Contains(text(r), "reused tab") {
				t.Fatalf("a new tab opens and the agent is told why: %s", text(r))
			}
			if w.tabCount() != count+1 {
				t.Fatalf("one tab opened: %d, was %d", w.tabCount(), count)
			}
			info, _ := w.m.tab(w.sid, tabId)
			if info.key.BrowserTabId == "docs-tab" || info.origin != OriginOpened {
				t.Fatalf("the new tab is the agent's own: %+v", info)
			}
			if _, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
				t.Fatalf("the developer's tab was not taken")
			}
			if got := w.pageFor(info.key).current(); got != guideUrl {
				t.Fatalf("the page loads in the new tab: %q", got)
			}
			if asks := w.m.panelState("p2").Asks; len(asks) != 0 {
				t.Fatalf("the question is gone: %+v", asks)
			}
		})
	}
}

func TestNoAnswerGivesAStatedResultAndOpensNothing(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	w.m.reuseTimeout = 20 * time.Millisecond
	count := w.tabCount()
	r := w.create(guideUrl, "")
	if r.IsError || !strings.Contains(text(r), mcpbrowser.ReuseWaitingStatus) || !strings.Contains(text(r), "Nothing was opened and nothing was taken") {
		t.Fatalf("a stated result, not a silent new tab: %s", text(r))
	}
	if w.tabCount() != count {
		t.Fatalf("nothing opened: %d tabs, were %d", w.tabCount(), count)
	}
	if _, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
		t.Fatalf("nothing was taken")
	}
	if asks := w.m.panelState("p2").Asks; len(asks) != 0 {
		t.Fatalf("the question is withdrawn: %+v", asks)
	}
	if state, ok := w.env.lastPublished("p2"); !ok || len(state.Asks) != 0 {
		t.Fatalf("the panel is told the question is gone: %+v", state)
	}
	w.m.reuseTimeout = time.Minute
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p2")
	w.answer(t, "p2", ask, DecisionAllow)
	if r := w.result(t, pending); !strings.Contains(text(r), "reused tab") {
		t.Fatalf("asking again works: %s", text(r))
	}
}

func TestACancelledCallWithdrawsItsQuestion(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan mcpbrowser.CallResult, 1)
	go func() {
		done <- w.m.Call(ctx, "proc:a", mcpbrowser.CallRequest{SessionId: w.sid, Tool: mcpbrowser.ToolTabsCreate, Args: json.RawMessage(fmt.Sprintf(`{"url":%q}`, guideUrl))})
	}()
	w.waitAsk(t, "p2")
	cancel()
	expectError(t, w.result(t, done), mcpbrowser.ErrCallCancelled)
	if asks := w.m.panelState("p2").Asks; len(asks) != 0 {
		t.Fatalf("the question is withdrawn with the call: %+v", asks)
	}
	if _, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
		t.Fatalf("nothing was taken")
	}
}

func TestOnlyTheWindowAnswersAndOnlyForItsPanel(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p2")
	req := AnswerRequest{BlockId: "p2", BrowserTabId: ask.BrowserTabId, RequestId: ask.RequestId, Decision: DecisionAllow}
	if err := w.m.Answer("proc:a", req); err == nil {
		t.Fatalf("an agent cannot allow itself")
	}
	wrong := req
	wrong.BlockId = "p3"
	if err := w.m.Answer(wshutil.ElectronRoute, wrong); err != nil {
		t.Fatalf("an answer for another panel is ignored: %v", err)
	}
	wrongDecision := req
	wrongDecision.Decision = DecisionOnce
	if err := w.m.Answer(wshutil.ElectronRoute, wrongDecision); err != nil {
		t.Fatalf("a site answer does not fit this question: %v", err)
	}
	if asks := w.m.panelState("p2").Asks; len(asks) != 1 {
		t.Fatalf("none of these answered the question: %+v", asks)
	}
	if _, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
		t.Fatalf("nothing was taken without the developer's Allow")
	}
	w.answer(t, "p2", ask, DecisionDeny)
	w.result(t, pending)
}

func TestTwoCallsOnTheSamePageShareOneQuestion(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	first := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p2")
	second := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	deadline := time.Now().Add(waitFor)
	for time.Now().Before(deadline) {
		w.m.lock.Lock()
		waiters := 0
		for _, req := range w.m.requests {
			if req.kind == PromptReuse {
				waiters = req.waiters
			}
		}
		w.m.lock.Unlock()
		if waiters == 2 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if asks := w.m.panelState("p2").Asks; len(asks) != 1 {
		t.Fatalf("one question for the page: %+v", asks)
	}
	w.answer(t, "p2", ask, DecisionAllow)
	a, b := w.result(t, first), w.result(t, second)
	if resultTabId(t, a) != resultTabId(t, b) || !strings.Contains(text(a), "reused tab") || !strings.Contains(text(b), "reused tab") {
		t.Fatalf("both calls land on the one shared tab: %s | %s", text(a), text(b))
	}
}

func TestThePageThatChangedWhileTheDeveloperWasAskedIsNotHandedOver(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p2")
	w.env.setPage("p2", "docs-tab", "https://docs.example/other", "Something else")
	w.answer(t, "p2", ask, DecisionAllow)
	r := w.result(t, pending)
	tabId := resultTabId(t, r)
	if !strings.Contains(text(r), "opened tab") || !strings.Contains(text(r), "changed while they were asked") {
		t.Fatalf("a changed page is not what the developer allowed: %s", text(r))
	}
	if info, _ := w.m.tab(w.sid, tabId); info.key.BrowserTabId == "docs-tab" {
		t.Fatalf("their tab was not taken")
	}
	if _, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); held {
		t.Fatalf("their tab was not taken")
	}
}

func TestAPageAnotherAgentHoldsIsNeitherAskedNorTaken(t *testing.T) {
	w := makeReuseWorld(t)
	other := hello(t, w.m, "proc:b", "tok-b", "codex")
	shared := w.m.shareTab(other, TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}, false, "docs.example")
	if shared.result != shareAdded {
		t.Fatalf("share: %+v", shared)
	}
	w.env.recent["p3"] = 0
	// docs-tab is codex's now, docs-tab-2 is still the developer's: the question goes to the one that is free.
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	ask := w.waitAsk(t, "p3")
	if ask.BrowserTabId != "docs-tab-2" {
		t.Fatalf("a held page is not asked about: %+v", ask)
	}
	if asks := w.m.panelState("p2").Asks; len(asks) != 0 {
		t.Fatalf("no question on the held page: %+v", asks)
	}
	w.answer(t, "p3", ask, DecisionDeny)
	w.result(t, pending)
	if owner, held := w.m.holderOf(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"}); !held || owner.id != other {
		t.Fatalf("codex keeps its tab")
	}
	listed := parseContext(t, w.call(mcpbrowser.ToolTabsContext, `{}`))
	foundHeld := false
	for _, page := range listed.OtherPages {
		if page.Owner == pageOwnerAgent && page.Agent == "codex" && page.State == pageStateControlled && page.Reuse == "" {
			foundHeld = true
		}
	}
	if !foundHeld {
		t.Fatalf("another agent's page is listed with its owner: %+v", listed.OtherPages)
	}
}

func TestAPageInAnotherWaveTabOrWorkspaceIsNeverAskedNorReused(t *testing.T) {
	w := makeReuseWorld(t)
	// Only the guide pages of the agent's own Wave tab, the other Wave tab and the other workspace match this address:
	// take away the ones of the agent's Wave tab.
	w.env.panels["p2"].Tabs = nil
	w.env.panels["p3"].Tabs = nil
	count := w.tabCount()
	r := w.create(guideUrl, "")
	tabId := resultTabId(t, r)
	if !strings.Contains(text(r), "opened tab") {
		t.Fatalf("a page nobody offers is opened: %s", text(r))
	}
	if w.tabCount() != count+1 {
		t.Fatalf("a new tab opened")
	}
	info, _ := w.m.tab(w.sid, tabId)
	if info.key.PanelId == "p4" || info.key.PanelId == "p5" {
		t.Fatalf("the new tab is in the agent's own panels: %+v", info)
	}
	w.otherAsksEmpty(t)
	for _, key := range []TabKey{{PanelId: "p4", BrowserTabId: "review-tab"}, {PanelId: "p5", BrowserTabId: "elsewhere-tab"}} {
		if _, held := w.m.holderOf(key); held {
			t.Fatalf("%v was taken", key)
		}
	}
}

func TestATabTheDeveloperTookOverIsNotOpenedAgain(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page", ""))
	info, _ := w.m.tab(w.sid, tabId)
	// The panel saves the page it shows; a tab the user took over is read from that copy.
	w.env.setPage(info.key.PanelId, info.key.BrowserTabId, "https://mine.example/page", "Mine")
	if err := w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: info.key.PanelId, BrowserTabId: info.key.BrowserTabId, Action: ControlTakeOver}); err != nil {
		t.Fatalf("take over: %v", err)
	}
	count := w.tabCount()
	expectError(t, w.create("https://mine.example/page", ""), mcpbrowser.ErrTakenOver)
	if w.tabCount() != count {
		t.Fatalf("a page the developer is using is not opened a second time")
	}
	if r := w.create("https://mine.example/page", `"newTab":true`); r.IsError {
		t.Fatalf("newTab is still the way to a second copy: %s", text(r))
	}
}

func TestAStoppedTabBecomesTheDevelopersAgainAndIsAskedFor(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page", ""))
	info, _ := w.m.tab(w.sid, tabId)
	w.env.setPage(info.key.PanelId, info.key.BrowserTabId, "https://mine.example/page", "Mine")
	if err := w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: info.key.PanelId, BrowserTabId: info.key.BrowserTabId, Action: ControlStop}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, `{"url":"https://mine.example/page"}`)
	ask := w.waitAsk(t, info.key.PanelId)
	if ask.BrowserTabId != info.key.BrowserTabId {
		t.Fatalf("the stopped tab is the developer's again: %+v", ask)
	}
	w.answer(t, info.key.PanelId, ask, DecisionDeny)
	w.result(t, pending)
}

func TestABlockedSiteIsNeitherListedNorAsked(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("docs.example", SiteBlock)
	listed := parseContext(t, w.call(mcpbrowser.ToolTabsContext, `{}`))
	for _, page := range listed.OtherPages {
		if page.Site == "docs.example" {
			t.Fatalf("a site the user blocked agents on is left out: %+v", page)
		}
	}
	expectError(t, w.create(guideUrl, ""), mcpbrowser.ErrSiteBlocked)
	w.otherAsksEmpty(t)
}

func TestTabsContextListsTheWorkspacesPagesWithoutSecretsOrOtherWorkspaces(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.panels["p2"].Tabs[0].Url = "https://user:hunter2@docs.example/guide?token=SECRET-Q&lang=en#access_token=SECRET-F"
	w.env.panels["p3"].Tabs[0].Url = "https://docs.example/private?code=SECRET-C&page=2#frag"
	out := text(w.call(mcpbrowser.ToolTabsContext, `{}`))
	for _, secret := range []string{"hunter2", "SECRET-Q", "SECRET-F", "SECRET-C", "docs-tab", "review-tab", "elsewhere-tab", "user-tab", "My bank", "Guide in another workspace", "SECRET"} {
		if strings.Contains(out, secret) {
			t.Fatalf("%q must not come back:\n%s", secret, out)
		}
	}
	listed := parseContext(t, mcpbrowser.TextResult(out))
	if len(listed.Tabs) != 0 || len(listed.OtherPages) != 4 {
		t.Fatalf("no tab of the agent's own, and four pages of the workspace (the bank, two guides and the one of the other Wave tab): %+v", listed)
	}
	for _, page := range listed.OtherPages {
		if page.Owner != pageOwnerUser || page.State != pageStateOpen {
			t.Fatalf("the developer's pages are listed as open: %+v", page)
		}
	}
	here := 0
	elsewhere := 0
	for _, page := range listed.OtherPages {
		switch {
		case strings.HasSuffix(page.Panel, "of this tab") && page.Reuse == pageReuseAsk:
			here++
		case strings.HasSuffix(page.Panel, "of another tab") && page.Reuse == "":
			elsewhere++
		}
	}
	if here != 3 || elsewhere != 1 {
		t.Fatalf("three pages beside the terminal can be asked for, one in another Wave tab cannot: %+v", listed.OtherPages)
	}
	if !strings.Contains(out, `"tab":"Review"`) || !strings.Contains(out, "<untrusted-page-content") {
		t.Fatalf("the Wave tab's name and the page text come inside the envelope: %s", out)
	}
	if !strings.Contains(out, "docs.example") {
		t.Fatalf("the allowed site shows its pages: %s", out)
	}
	// The addresses of an allowed site are masked; the title is the page's.
	if !strings.Contains(out, "https://docs.example/guide?token=***\\u0026lang=en") && !strings.Contains(out, "https://docs.example/guide?token=***&lang=en") {
		t.Fatalf("the secret query parameter is masked: %s", out)
	}
	if !strings.Contains(out, "code=***") || !strings.Contains(out, "page=2") || strings.Contains(out, "#frag") {
		t.Fatalf("a code is masked, the rest of the query kept, the fragment dropped: %s", out)
	}
	if !strings.Contains(out, "tabs_create with its address") {
		t.Fatalf("the listing says how to use a page: %s", out)
	}
}

func TestTabsContextHidesTitleAndAddressOfASiteTheSessionMayNotUse(t *testing.T) {
	w := makeReuseWorld(t)
	out := text(w.call(mcpbrowser.ToolTabsContext, `{}`))
	if !strings.Contains(out, "bank.example") {
		t.Fatalf("the page is listed by its site: %s", out)
	}
	for _, hidden := range []string{"My bank", "/account", "SECRET-Q"} {
		if strings.Contains(out, hidden) {
			t.Fatalf("%q is for a site the session may not use yet: %s", hidden, out)
		}
	}
	w.env.SetAgentSite("bank.example", SiteAllow)
	out = text(w.call(mcpbrowser.ToolTabsContext, `{}`))
	if !strings.Contains(out, "My bank") || !strings.Contains(out, "/account?token=***") || strings.Contains(out, "SECRET-Q") {
		t.Fatalf("an allowed site shows its title and a masked address: %s", out)
	}
}

func TestTabsContextOnlyEverListsTheOwnWorkspace(t *testing.T) {
	w := makeReuseWorld(t)
	other := hello(t, w.m, "proc:c", "tok-c", "codex")
	listed := parseContext(t, call(w.m, "proc:c", other, mcpbrowser.ToolTabsContext, `{}`))
	if len(listed.OtherPages) != 1 || listed.OtherPages[0].Panel != "panel 1 of this tab" {
		t.Fatalf("the other workspace sees its own page only: %+v", listed.OtherPages)
	}
	out := text(call(w.m, "proc:c", other, mcpbrowser.ToolTabsContext, `{}`))
	for _, leaked := range []string{"bank.example", "The guide", "Main", "Review"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("%q belongs to another workspace: %s", leaked, out)
		}
	}
	pending := make(chan mcpbrowser.CallResult, 1)
	go func() {
		pending <- call(w.m, "proc:c", other, mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	}()
	ask := w.waitAsk(t, "p5")
	if ask.AgentName != "codex" || ask.BrowserTabId != "elsewhere-tab" {
		t.Fatalf("the question is about the page of its own workspace: %+v", ask)
	}
	w.otherAsksEmpty2(t, "p5")
	w.answer(t, "p5", ask, DecisionDeny)
	r := w.result(t, pending)
	if !strings.Contains(text(r), "opened tab") {
		t.Fatalf("a new tab opens in its own workspace: %s", text(r))
	}
	w.otherAsksEmpty(t)
}

func TestReuseWorksInABatchAndIsLoggedWithoutThePage(t *testing.T) {
	w := makeReuseWorld(t)
	w.env.SetAgentSite("mine.example", SiteAllow)
	tabId := resultTabId(t, w.create("https://mine.example/page?token=SECRET-L", ""))
	batch := `{"actions":[{"name":"tabs_create","input":{"url":"https://mine.example/page?token=SECRET-L"}}]}`
	r := w.call(mcpbrowser.ToolBatch, batch)
	if r.IsError || !strings.Contains(text(r), "reused tab") || !strings.Contains(text(r), fmt.Sprintf(`"tabId":%d`, tabId)) {
		t.Fatalf("a batch can reuse a page: %s", text(r))
	}
	logged := w.sink.all()
	if !strings.Contains(logged, "tool=tabs_create") || strings.Contains(logged, "SECRET-L") || strings.Contains(logged, "/page") {
		t.Fatalf("the audit log holds the tool and the host, not the address: %s", logged)
	}
}

func TestTheAskIsAPermissionQuestionOfItsOwnKind(t *testing.T) {
	if decisionFits(PromptReuse, DecisionOnce) || decisionFits(PromptReuse, DecisionAlways) || decisionFits(PromptReuse, DecisionBlock) {
		t.Fatalf("a reuse question takes no site answer")
	}
	for _, decision := range []string{DecisionAllow, DecisionDeny, DecisionDismiss} {
		if !decisionFits(PromptReuse, decision) {
			t.Fatalf("a reuse question takes %s", decision)
		}
	}
	w := makeReuseWorld(t)
	w.env.recent["p2"] = 0
	pending := w.callAsync(mcpbrowser.ToolTabsCreate, fmt.Sprintf(`{"url":%q}`, guideUrl))
	w.waitAsk(t, "p2")
	w.m.lock.Lock()
	prompt := w.m.pendingPromptLocked(TabKey{PanelId: "p2", BrowserTabId: "docs-tab"})
	w.m.lock.Unlock()
	if prompt != nil {
		t.Fatalf("a reuse question is listed as an ask, never as a permission on a tab the agent does not hold: %+v", prompt)
	}
	w.m.endSessions(func(s *session) bool { return s.id == w.sid }, "ended")
	expectError(t, w.result(t, pending), mcpbrowser.ErrSessionEnded)
	if asks := w.m.panelState("p2").Asks; len(asks) != 0 {
		t.Fatalf("a session that ended asks nothing: %+v", asks)
	}
	if state, _ := w.env.lastPublished("p2"); len(state.Asks) != 0 {
		t.Fatalf("the panel is told the question is over: %+v", state)
	}
}
