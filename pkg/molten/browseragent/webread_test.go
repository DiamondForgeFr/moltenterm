// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func webRead(t *testing.T, m *Manager, url string) WebReadAnswer {
	t.Helper()
	answer, err := m.WebRead(wshutil.ElectronRoute, WebReadRequest{Url: url})
	if err != nil {
		t.Fatalf("WebRead %s: %v", url, err)
	}
	return answer
}

// #1976: `wsh web get` reads a Wave web block's page in its own world, with the panel's sign-ins, so it takes what the
// browser tools take: a stored Always for the site.
func TestWebReadNeedsAStoredAlways(t *testing.T) {
	m, env, _ := makeWorld(t)
	if a := webRead(t, m, "https://mail.example.com/inbox"); a.Allow || a.Error != mcpbrowser.ErrWebReadNotAllowed || a.Site != "example.com" {
		t.Fatalf("a site with no decision is refused: %+v", a)
	}
	env.SetAgentSite("example.com", SiteAllow)
	if a := webRead(t, m, "https://mail.example.com/inbox"); !a.Allow || a.Site != "example.com" || a.Error != "" {
		t.Fatalf("an Always covers the site's subdomains: %+v", a)
	}
	if a := webRead(t, m, "https://other.example/"); a.Allow || a.Error != mcpbrowser.ErrWebReadNotAllowed {
		t.Fatalf("another site stays refused: %+v", a)
	}
	env.SetAgentSite("pay.example.com", SiteBlock)
	if a := webRead(t, m, "https://pay.example.com/"); a.Allow || a.Error != mcpbrowser.ErrSiteBlocked {
		t.Fatalf("a Block wins over the site's Always: %+v", a)
	}
}

// The reason the decision is read in wavesrv: its site rules know the public suffix list. An Always for github.io (the
// host itself) does not cover a stranger's page under it.
func TestWebReadKeepsWavesrvSiteRules(t *testing.T) {
	m, env, _ := makeWorld(t)
	env.SetAgentSite("github.io", SiteAllow)
	if a := webRead(t, m, "https://github.io/"); !a.Allow {
		t.Fatalf("the host that was allowed: %+v", a)
	}
	if a := webRead(t, m, "https://stranger.github.io/"); a.Allow {
		t.Fatalf("a page under a public suffix is a site of its own: %+v", a)
	}
	env.SetAgentSite("localhost:3000", SiteAllow)
	if a := webRead(t, m, "http://localhost:3000/app"); !a.Allow {
		t.Fatalf("a dev server's port is its own site: %+v", a)
	}
	if a := webRead(t, m, "http://localhost:8080/app"); a.Allow {
		t.Fatalf("another port is another site: %+v", a)
	}
}

func TestWebReadRefusesWhatIsNotAWebPage(t *testing.T) {
	m, env, _ := makeWorld(t)
	env.SetAgentSite("example.com", SiteAllow)
	for _, url := range []string{
		"", "about:blank", "file:///etc/passwd", "data:text/html,<p>x</p>", "javascript:alert(1)", "chrome://settings",
		"http://2130706433/", "https://example.com%20.evil.example/",
	} {
		if a := webRead(t, m, url); a.Allow || a.Error != mcpbrowser.ErrUnreadablePage {
			t.Fatalf("%q is not a page agents read: %+v", url, a)
		}
	}
}

// Allow once is a session's: a terminal's command has no session, so it never counts, however fresh the answer.
func TestWebReadIgnoresAllowOnce(t *testing.T) {
	w := makePageWorld(t)
	pending := w.callAsync(mcpbrowser.ToolNavigate, w.args(`"url":"https://once.example/"`))
	w.answer(t, w.prompt(t), DecisionOnce)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("allow once: %s", text(r))
	}
	if a := webRead(t, w.m, "https://once.example/"); a.Allow || a.Error != mcpbrowser.ErrWebReadNotAllowed {
		t.Fatalf("an Allow once does not open the site to a terminal: %+v", a)
	}

	pending = w.callAsync(mcpbrowser.ToolNavigate, w.args(`"url":"https://always.example/"`))
	w.answer(t, w.prompt(t), DecisionAlways)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("always: %s", text(r))
	}
	if a := webRead(t, w.m, "https://always.example/"); !a.Allow {
		t.Fatalf("an Always, just answered, counts at once: %+v", a)
	}
}

func TestWebReadIsAskedByElectronMainOnly(t *testing.T) {
	m, env, _ := makeWorld(t)
	env.SetAgentSite("example.com", SiteAllow)
	for _, source := range []string{"proc:a", "tab:t1", "conn:ssh", "", "feblock:p1"} {
		if _, err := m.WebRead(source, WebReadRequest{Url: "https://example.com/"}); err == nil {
			t.Fatalf("%q must not ask: a terminal or a window cannot vouch for a page", source)
		}
	}
}

func TestWebReadRouteAnswersElectronMainAndNoOtherCaller(t *testing.T) {
	_, env, e, link := makeRouteWorld(t)
	env.SetAgentSite("example.com", SiteAllow)
	data, errStr := routetest.Ask(t, link, e.Electron(), mcpbrowser.WebReadCommand, WebReadRequest{Url: "https://example.com/"})
	answer, ok := data.(map[string]any)
	if errStr != "" || !ok || answer["allow"] != true || answer["site"] != "example.com" {
		t.Fatalf("electron main asks: %q %v", errStr, data)
	}
	nonElectron := append([]routetest.From{e.Terminal()}, e.Forged()...)
	routetest.MustRefuse(t, link, nonElectron, mcpbrowser.WebReadCommand, WebReadRequest{Url: "https://example.com/"})
}

func TestWebReadLogsTheHostAndNeverTheAddress(t *testing.T) {
	m, env, sink := makeWorld(t)
	env.SetAgentSite("example.com", SiteAllow)
	webRead(t, m, "https://mail.example.com/inbox/SECRET-PATH?token=SECRET-Q#SECRET-F")
	webRead(t, m, "https://nodecision.example/SECRET-PATH?token=SECRET-Q")
	logged := sink.all()
	if !strings.Contains(logged, "site=example.com") || !strings.Contains(logged, "site=nodecision.example") {
		t.Fatalf("the log names the sites: %q", logged)
	}
	for _, secret := range []string{"SECRET-PATH", "SECRET-Q", "SECRET-F", "inbox"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("the log holds %q: %q", secret, logged)
		}
	}
}
