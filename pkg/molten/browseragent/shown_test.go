// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// A page an agent shows (tabs_create, navigate) is stamped on its tab, so a panel off-screen on the 360 carpet scrolls
// into view (#1812). The stamps are compared with each other or with an injected clock, never with how long a call takes.

type shownClock struct{ ms atomic.Int64 }

func (c *shownClock) now() time.Time { return time.UnixMilli(c.ms.Load()) }

func (c *shownClock) set(ms int64) { c.ms.Store(ms) }

// makeShownWorld is makePageWorld with the manager's clock set before the agent opens its tab.
func makeShownWorld(t *testing.T, clock *shownClock) *pageWorld {
	t.Helper()
	m, env, sink := makeWorld(t)
	m.now = clock.now
	m.permissionTimeout = time.Minute
	m.permissionPoll = 5 * time.Millisecond
	page := makeFakePage()
	page.tree = signInTree()
	page.describe = signInDescribe()
	env.cdpFn = page.cdp
	sid := hello(t, m, "proc:a", "tok-a", "claude-code")
	tab := createdTabId(t, call(m, "proc:a", sid, mcpbrowser.ToolTabsCreate, `{}`))
	info, _ := m.tab(sid, tab)
	return &pageWorld{m: m, env: env, sink: sink, page: page, sid: sid, tab: tab, key: info.key}
}

func shownTsOf(t *testing.T, m *Manager, key TabKey) int64 {
	t.Helper()
	for _, tab := range m.panelState(key.PanelId).Tabs {
		if tab.BrowserTabId == key.BrowserTabId {
			return tab.ShownTs
		}
	}
	t.Fatalf("no tab %v in the panel state", key)
	return 0
}

func lastPublishedShownTs(t *testing.T, env *fakeEnv, key TabKey) int64 {
	t.Helper()
	state, ok := env.lastPublished(key.PanelId)
	if !ok {
		t.Fatalf("nothing was published for panel %s", key.PanelId)
	}
	for _, tab := range state.Tabs {
		if tab.BrowserTabId == key.BrowserTabId {
			return tab.ShownTs
		}
	}
	t.Fatalf("no tab %v in the published state", key)
	return 0
}

func TestTabsCreateStampsTheTabAsShown(t *testing.T) {
	clock := &shownClock{}
	clock.set(1_000_000)
	w := makeShownWorld(t, clock)
	if got := shownTsOf(t, w.m, w.key); got != 1_000_000 {
		t.Fatalf("an opened tab is shown when it is opened: shownts = %d", got)
	}
	if got := lastPublishedShownTs(t, w.env, w.key); got != 1_000_000 {
		t.Fatalf("the panel is told: shownts = %d", got)
	}
}

func TestNavigateStampsThePageBeforeItAsksTheSite(t *testing.T) {
	w := makePageWorld(t)
	opened := shownTsOf(t, w.m, w.key)
	pending := w.callAsync(mcpbrowser.ToolNavigate, w.args(`"url":"example.com/docs"`))
	p := w.prompt(t)
	if got := shownTsOf(t, w.m, w.key); got <= opened {
		t.Fatalf("the question is asked in a panel the developer sees: shownts = %d, opened at %d", got, opened)
	}
	if got, want := lastPublishedShownTs(t, w.env, w.key), shownTsOf(t, w.m, w.key); got != want {
		t.Fatalf("the panel is told before the answer: published %d, held %d", got, want)
	}
	w.answer(t, p, DecisionOnce)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("navigate: %s", text(r))
	}
}

func TestEveryNavigationShowsThePageAgainEvenWithinTheSameMillisecond(t *testing.T) {
	clock := &shownClock{}
	clock.set(3_000_000)
	w := makeShownWorld(t, clock)
	w.navigateAllowed(t, "https://example.com/one")
	first := shownTsOf(t, w.m, w.key)
	w.navigateAllowed(t, "https://example.com/two")
	second := shownTsOf(t, w.m, w.key)
	if first <= 3_000_000 || second <= first {
		t.Fatalf("shownts must increase on every navigation: opened at 3000000, then %d, then %d", first, second)
	}
	if r := w.call(mcpbrowser.ToolNavigate, w.args(`"url":"back"`)); r.IsError {
		t.Fatalf("back: %s", text(r))
	}
	if third := shownTsOf(t, w.m, w.key); third <= second {
		t.Fatalf("back shows the page again: %d then %d", second, third)
	}
}

func TestOnlyOpeningAndNavigatingShowAPage(t *testing.T) {
	clock := &shownClock{}
	clock.set(4_000_000)
	w := makeShownWorld(t, clock)
	w.navigateAllowed(t, "https://example.com/docs")
	shown := shownTsOf(t, w.m, w.key)
	clock.set(4_000_500)
	w.call(mcpbrowser.ToolReadPage, w.args(""))
	w.call(mcpbrowser.ToolGetPageText, w.args(""))
	w.call(mcpbrowser.ToolFind, w.args(`"query":"search box"`))
	w.call(mcpbrowser.ToolComputer, w.args(`"action":"wait","duration":0`))
	if got := shownTsOf(t, w.m, w.key); got != shown {
		t.Fatalf("reading and acting never scroll the carpet: shownts %d, was %d", got, shown)
	}
}

func TestARefusedNavigationShowsNothing(t *testing.T) {
	clock := &shownClock{}
	clock.set(5_000_000)
	w := makeShownWorld(t, clock)
	opened := shownTsOf(t, w.m, w.key)
	expectError(t, w.call(mcpbrowser.ToolNavigate, w.args(`"url":"file:///etc/passwd"`)), mcpbrowser.ErrSchemeRefused)
	expectError(t, w.call(mcpbrowser.ToolNavigate, w.args(`"url":"back"`)), mcpbrowser.ErrNoHistory)
	if got := shownTsOf(t, w.m, w.key); got != opened {
		t.Fatalf("a refused navigation brings nothing in front of the developer: shownts %d, was %d", got, opened)
	}
}
