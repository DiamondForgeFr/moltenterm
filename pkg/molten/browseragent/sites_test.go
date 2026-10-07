// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"strings"
	"testing"
)

func TestPermissionSite(t *testing.T) {
	cases := map[string]string{
		"https://mail.example.com/inbox?x=1": "example.com",
		"https://www.example.co.uk/":         "example.co.uk",
		"http://localhost:3000/app":          "localhost:3000",
		"http://localhost/":                  "localhost",
		"http://127.0.0.1:8080/x":            "127.0.0.1:8080",
		"http://[::1]:5173/":                 "[::1]:5173",
		"http://intranet/":                   "intranet",
		"https://user.github.io/repo":        "user.github.io",
		"https://github.io/":                 "github.io",
		"HTTPS://Shop.EXAMPLE.org./":         "example.org",
		"https://app.dev.localhost:4000/":    "app.dev.localhost:4000",
		"file:///etc/passwd":                 "",
		"about:blank":                        "",
		"javascript:alert(1)":                "",
		"data:text/html,<b>x</b>":            "",
		"wave://settings":                    "",
		"https://a\"b.example/":              "",
		"https://xn--bcher-kva.example/":     "xn--bcher-kva.example",
		"http://127.0.0.1.:8080/":            "127.0.0.1:8080",
		"https://example.com.:443/":          "example.com",
		"http://2130706433:8080/":            "",
		"http://0x7f.1/":                     "",
		"http://127.1/":                      "",
		"http://192.168.001.1/":              "",
		"http://192.168.1.1/":                "192.168.1.1",
	}
	for in, want := range cases {
		if got := permissionSite(in); got != want {
			t.Errorf("permissionSite(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStoredDecisionBlockWins(t *testing.T) {
	sites := map[string]string{"example.com": "allow", "evil.example.com": "block", "localhost:3000": "allow", " Other.ORG ": "ALLOW"}
	cases := map[string]string{
		"https://example.com/":            SiteAllow,
		"https://a.b.example.com/":        SiteAllow,
		"https://evil.example.com/x":      SiteBlock,
		"https://x.evil.example.com/":     SiteBlock,
		"http://localhost:3000/":          SiteAllow,
		"http://localhost:8080/":          "",
		"https://other.org/":              SiteAllow,
		"https://example.com.attacker.io": "",
		"about:blank":                     "",
	}
	for in, want := range cases {
		if got := storedDecision(sites, in); got != want {
			t.Errorf("storedDecision(%q) = %q, want %q", in, got, want)
		}
	}
	if storedDecision(map[string]string{"example.com": "allow", "app.example.com": "block"}, "https://app.example.com/") != SiteBlock {
		t.Fatalf("a block on the host wins over an allow on its domain")
	}
	if storedDecision(map[string]string{"example.com": "block", "app.example.com": "allow"}, "https://app.example.com/") != SiteBlock {
		t.Fatalf("a block on the domain wins over an allow on the host")
	}
}

func TestNavigateTarget(t *testing.T) {
	ok := map[string]string{
		"example.com":             "https://example.com",
		"example.com/path?q=1":    "https://example.com/path?q=1",
		"localhost:3000/x":        "http://localhost:3000/x",
		"127.0.0.1:8080":          "http://127.0.0.1:8080",
		"http://example.com":      "http://example.com",
		"https://example.com/a#b": "https://example.com/a#b",
		"  https://example.com  ": "https://example.com",
		"example.com:8443/secure": "https://example.com:8443/secure",
		"localhost.example.com":   "https://localhost.example.com",
		"127.0.0.1.nip.io":        "https://127.0.0.1.nip.io",
		"[::1]:5173/":             "http://[::1]:5173/",
	}
	for in, want := range ok {
		got, problem := navigateTarget(in)
		if problem != "" || got != want {
			t.Errorf("navigateTarget(%q) = %q %q, want %q", in, got, problem, want)
		}
	}
	for _, in := range []string{"file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "chrome://settings",
		"devtools://devtools/x", "wave://x", "mailto:a@b.c", "https://user:pass@example.com/", "ftp://example.com"} {
		if _, problem := navigateTarget(in); problem != "scheme" {
			t.Errorf("navigateTarget(%q) must be refused, got %q", in, problem)
		}
	}
	if _, problem := navigateTarget("  "); problem != "missing" {
		t.Fatalf("an empty url is missing")
	}
}

func TestValidSiteKey(t *testing.T) {
	for _, site := range []string{"example.com", "localhost:3000", "[::1]:5173", "a-b.example"} {
		if !validSiteKey(site) {
			t.Errorf("%q is a site", site)
		}
	}
	for _, site := range []string{"", "Example.com", "a b", "x/y", ".example.com", "example.com.", strings.Repeat("a", 300)} {
		if validSiteKey(site) {
			t.Errorf("%q is not a site", site)
		}
	}
}
