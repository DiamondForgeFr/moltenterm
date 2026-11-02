// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinks"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// linksEnv is the link registry's wavesrv, with the browser's tokens.
type linksEnv struct {
	browser *fakeEnv
	lock    sync.Mutex
	stops   map[string][]string
}

func (e *linksEnv) VerifyToken(token string) (string, error) { return e.browser.VerifyToken(token) }
func (e *linksEnv) Run(blockId string) (molten.AgentRunInfo, bool) {
	return molten.AgentRunInfo{}, false
}
func (e *linksEnv) Runs() []molten.AgentRunInfo { return nil }
func (e *linksEnv) Alive(pid int) bool          { return true }
func (e *linksEnv) Stops(blockId string) []string {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]string{}, e.stops[blockId]...)
}
func (e *linksEnv) SetStops(blockId string, keys []string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.stops[blockId] = keys
}
func (e *linksEnv) Publish(state agentlinkwire.BlockLinks) {}
func (e *linksEnv) Version() string                        { return "test" }

// makeLinkedWorld is a wavesrv that just started: the browser's sessions and the link registry, wired as Start does.
func makeLinkedWorld(t *testing.T) (*Manager, *agentlinks.Manager, *linksEnv) {
	t.Helper()
	m, env, _ := makeWorld(t)
	lenv := &linksEnv{browser: env, stops: map[string][]string{}}
	links := agentlinks.MakeManager(lenv)
	links.OnReport(m.linkReport)
	return m, links, lenv
}

func report(t *testing.T, links *agentlinks.Manager, source string, blockId string, server string) {
	t.Helper()
	reportPid(t, links, source, blockId, server, 4242)
}

func reportPid(t *testing.T, links *agentlinks.Manager, source string, blockId string, server string, pid int) {
	t.Helper()
	caller := localroute.Caller{Source: source, IsLocalTerminal: true, BlockId: blockId}
	req := agentlinkwire.WatchRequest{Token: "tok-" + blockId[len("term-"):], Server: server, Pid: pid, AgentPid: 4200,
		ClientName: "any-mcp-client", Version: "test"}
	if _, err := links.Watch(context.Background(), caller, req); err != nil {
		t.Fatalf("watch: %v", err)
	}
}

func listed(t *testing.T, m *Manager) map[string]string {
	t.Helper()
	res, err := m.ListSessions(context.Background(), "tab:t1", ListRequest{BlockId: "p1"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	rtn := map[string]string{}
	for _, s := range res.Sessions {
		rtn[s.BlockId] = s.SessionId
	}
	return rtn
}

// #1541: after wavesrv restarted (or the developer's Reconnect), the server's link reports on its new connection
// before the agent makes any browser call. The connections menu shows it connected at once, so Share with agent must
// list it at once too, and the server's next hello on that link must take the same session.
func TestALinkReportMakesTheAgentShareable(t *testing.T) {
	m, links, _ := makeLinkedWorld(t)
	report(t, links, "proc:a2", "term-a", agentlinkwire.ServerBrowser)
	sessions := listed(t, m)
	if sessions["term-a"] == "" {
		t.Fatalf("a connected link must be shareable without a call first: %v", sessions)
	}
	if got := hello(t, m, "proc:a2", "tok-a", "any-mcp-client"); got != sessions["term-a"] {
		t.Fatalf("hello on the same link opened another session: %s, want %s", got, sessions["term-a"])
	}
	report(t, links, "proc:a2", "term-a", agentlinkwire.ServerBrowser)
	if after := listed(t, m); len(after) != 1 || after["term-a"] != sessions["term-a"] {
		t.Fatalf("each report keeps the one session: %v", after)
	}
	share(t, m, sessions["term-a"], false)
}

func TestALinkReportOpensNoSessionForAnotherServerOrAStoppedLink(t *testing.T) {
	m, links, lenv := makeLinkedWorld(t)
	report(t, links, "proc:r", "term-a", agentlinkwire.ServerReview)
	lenv.SetStops("term-b", []string{agentlinks.LinkKey(agentlinkwire.ServerBrowser, 4242)})
	report(t, links, "proc:b", "term-b", agentlinkwire.ServerBrowser)
	if sessions := listed(t, m); len(sessions) != 0 {
		t.Fatalf("no browser session for a review link or a stopped link: %v", sessions)
	}
}

func holderOf(m *Manager) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.owners[TabKey{PanelId: "p1", BrowserTabId: "user-tab"}]
}

// A server that replaces its program (#1049) or reconnects at the developer's request comes back on a new link with
// the same process: the page shared with it stays shared, whichever of the old link's end and the new report comes
// first. Meanwhile the menu does not offer it, as the connections do not show it connected.
func TestAServerBackOnANewLinkKeepsItsSharedTab(t *testing.T) {
	for _, reportFirst := range []bool{false, true} {
		m, links, _ := makeLinkedWorld(t)
		report(t, links, "proc:a1", "term-a", agentlinkwire.ServerBrowser)
		sid := listed(t, m)["term-a"]
		share(t, m, sid, false)
		if reportFirst {
			report(t, links, "proc:a2", "term-a", agentlinkwire.ServerBrowser)
			m.EndSessionsForRoute("proc:a1")
		} else {
			m.EndSessionsForRoute("proc:a1")
			if sessions := listed(t, m); len(sessions) != 0 {
				t.Fatalf("a session without a link is not offered: %v", sessions)
			}
			report(t, links, "proc:a2", "term-a", agentlinkwire.ServerBrowser)
		}
		if got := listed(t, m)["term-a"]; got != sid {
			t.Fatalf("reportFirst=%v: the server's session must come back: %q, want %q", reportFirst, got, sid)
		}
		if got := hello(t, m, "proc:a2", "tok-a", "any-mcp-client"); got != sid {
			t.Fatalf("reportFirst=%v: hello on the new link = %q, want %q", reportFirst, got, sid)
		}
		if holderOf(m) != sid {
			t.Fatalf("reportFirst=%v: the shared tab was lost: holder %q", reportFirst, holderOf(m))
		}
	}
}

// Another process, or a server that never comes back, does not keep the tab.
func TestAParkedSessionEndsWhenItsServerDoesNotComeBack(t *testing.T) {
	m, links, _ := makeLinkedWorld(t)
	m.parkGrace = 10 * time.Millisecond
	report(t, links, "proc:a1", "term-a", agentlinkwire.ServerBrowser)
	sid := listed(t, m)["term-a"]
	share(t, m, sid, false)
	m.EndSessionsForRoute("proc:a1")
	reportPid(t, links, "proc:a9", "term-a", agentlinkwire.ServerBrowser, 9999)
	if got := listed(t, m)["term-a"]; got == "" || got == sid {
		t.Fatalf("another server gets a session of its own: %q (old %q)", got, sid)
	}
	deadline := time.Now().Add(time.Minute)
	for holderOf(m) != "" {
		if time.Now().After(deadline) {
			t.Fatalf("the parked session still holds the tab")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A server that does not report its link (before #1050) ends with its route, as before.
func TestASessionWithoutAReportEndsWithItsRoute(t *testing.T) {
	m, _, _ := makeLinkedWorld(t)
	sid := hello(t, m, "proc:a1", "tok-a", "any-mcp-client")
	share(t, m, sid, false)
	m.EndSessionsForRoute("proc:a1")
	if holderOf(m) != "" {
		t.Fatalf("the tab stays with a session that cannot come back")
	}
}

// The registry may hear from servers before the browser listens: they redial as soon as wavesrv is up.
func TestLinksReportedBeforeTheBrowserStartedGetTheirSession(t *testing.T) {
	m, env, _ := makeWorld(t)
	links := agentlinks.MakeManager(&linksEnv{browser: env, stops: map[string][]string{}})
	report(t, links, "proc:a2", "term-a", agentlinkwire.ServerBrowser)
	links.OnReport(m.linkReport)
	if sessions := listed(t, m); sessions["term-a"] == "" {
		t.Fatalf("an earlier report must get its session: %v", sessions)
	}
}
