// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// tabs_show (#1994) brings the page of a tab the agent already has in front of the developer: the same stamp as opening
// or navigating, nothing read from the page, nothing asked of the site. Stamps are compared with each other or with an
// injected clock, never with how long a call takes.

func publishedAgentTab(t *testing.T, env *fakeEnv, key TabKey) PanelAgentTab {
	t.Helper()
	state, ok := env.lastPublished(key.PanelId)
	if !ok {
		t.Fatalf("nothing was published for panel %s", key.PanelId)
	}
	for _, tab := range state.Tabs {
		if tab.BrowserTabId == key.BrowserTabId {
			return tab
		}
	}
	t.Fatalf("no tab %v in the published state", key)
	return PanelAgentTab{}
}

func TestTabsShowStampsTheTabAsShownAgain(t *testing.T) {
	clock := &shownClock{}
	clock.set(7_000_000)
	w := makeShownWorld(t, clock)
	w.navigateAllowed(t, "https://example.com/mockup")
	before := shownTsOf(t, w.m, w.key)
	clock.set(7_900_000)
	r := w.call(mcpbrowser.ToolTabsShow, w.args(""))
	if r.IsError {
		t.Fatalf("tabs_show: %s", text(r))
	}
	if got := shownTsOf(t, w.m, w.key); got != 7_900_000 || got <= before {
		t.Fatalf("showing the page again stamps it: shownts %d, was %d", got, before)
	}
	published := publishedAgentTab(t, w.env, w.key)
	if published.ShownTs != 7_900_000 {
		t.Fatalf("the panel is told: shownts = %d", published.ShownTs)
	}
	if published.Action != actionShown || published.ActionText == nil || published.ActionText.Code != "browser.action.shown" {
		t.Fatalf("the bar's line after the note says what the agent did: %+v", published)
	}
	if !strings.Contains(text(r), `"shown":true`) || !strings.Contains(text(r), "keyboard focus did not move") {
		t.Fatalf("the agent is told the page is in front of the user and the focus stayed: %s", text(r))
	}
}

func TestTabsShowShowsEvenWithinTheSameMillisecond(t *testing.T) {
	clock := &shownClock{}
	clock.set(8_000_000)
	w := makeShownWorld(t, clock)
	w.call(mcpbrowser.ToolTabsShow, w.args(""))
	first := shownTsOf(t, w.m, w.key)
	w.call(mcpbrowser.ToolTabsShow, w.args(""))
	if second := shownTsOf(t, w.m, w.key); second <= first {
		t.Fatalf("each call shows the page once more: %d then %d", first, second)
	}
}

func TestTabsShowReadsNothingAndAsksNoSite(t *testing.T) {
	w := makePageWorld(t)
	w.navigateAllowed(t, "https://example.com/docs")
	w.env.SetAgentSite("example.com", "")
	w.env.lock.Lock()
	calls := len(w.env.cdpCalls)
	w.env.lock.Unlock()
	if r := w.call(mcpbrowser.ToolTabsShow, w.args("")); r.IsError {
		t.Fatalf("a site without a decision does not stop tabs_show: %s", text(r))
	}
	w.env.lock.Lock()
	after := len(w.env.cdpCalls)
	w.env.lock.Unlock()
	if after != calls {
		t.Fatalf("tabs_show reads nothing from the page: %d DevTools calls, were %d", after, calls)
	}
	for _, tab := range w.m.panelState(w.key.PanelId).Tabs {
		if tab.Permission != nil {
			t.Fatalf("no question is asked for showing a page: %+v", tab.Permission)
		}
	}
}

func TestTabsShowRefusesWhatIsNotTheSessionsToShow(t *testing.T) {
	clock := &shownClock{}
	clock.set(9_000_000)
	w := makeShownWorld(t, clock)
	opened := shownTsOf(t, w.m, w.key)
	clock.set(9_500_000)
	expectError(t, w.call(mcpbrowser.ToolTabsShow, `{}`), mcpbrowser.ErrTabIdRequired)
	expectError(t, w.call(mcpbrowser.ToolTabsShow, `{"tabId":9999}`), mcpbrowser.ErrNotYourTab)
	other := hello(t, w.m, "proc:b", "tok-b", "codex")
	expectError(t, call(w.m, "proc:b", other, mcpbrowser.ToolTabsShow, w.args("")), mcpbrowser.ErrNotYourTab)
	if err := w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlTakeOver}); err != nil {
		t.Fatalf("take over: %v", err)
	}
	expectError(t, w.call(mcpbrowser.ToolTabsShow, w.args("")), mcpbrowser.ErrTakenOver)
	if got := shownTsOf(t, w.m, w.key); got != opened {
		t.Fatalf("a refused call shows nothing: shownts %d, was %d", got, opened)
	}
	if err := w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlStop}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	expectError(t, w.call(mcpbrowser.ToolTabsShow, w.args("")), mcpbrowser.ErrStopped)
}

func TestTabsShowCanBeChainedInABatch(t *testing.T) {
	clock := &shownClock{}
	clock.set(10_000_000)
	w := makeShownWorld(t, clock)
	opened := shownTsOf(t, w.m, w.key)
	clock.set(10_100_000)
	batch := fmt.Sprintf(`{"actions":[{"name":"tabs_show","input":{"tabId":%d}}]}`, w.tab)
	if r := w.call(mcpbrowser.ToolBatch, batch); r.IsError {
		t.Fatalf("browser_batch: %s", text(r))
	}
	if got := shownTsOf(t, w.m, w.key); got <= opened {
		t.Fatalf("a batch can show a page: shownts %d, was %d", got, opened)
	}
}

func TestTabsShowIsLoggedWithoutThePage(t *testing.T) {
	w := makePageWorld(t)
	w.navigateAllowed(t, "https://example.com/secret?token=SECRET-Q")
	w.call(mcpbrowser.ToolTabsShow, w.args(""))
	logged := w.sink.all()
	if !strings.Contains(logged, "tool=tabs_show") {
		t.Fatalf("the call is in the audit log: %s", logged)
	}
	if strings.Contains(logged, "SECRET-Q") {
		t.Fatalf("the log holds no query string: %s", logged)
	}
}
