// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"strings"
	"testing"
)

func TestNormalizePageAddressIgnoresWhatDoesNotMakeAnotherPage(t *testing.T) {
	t.Parallel()
	same := [][]string{
		{"https://docs.example/guide", "HTTPS://Docs.Example/guide", "https://docs.example:443/guide", "https://docs.example/guide/", "https://docs.example/guide#intro", " https://docs.example/guide "},
		{"https://docs.example", "https://docs.example/", "https://DOCS.example.:443/#top"},
		{"http://localhost:3000/app", "http://localhost:3000/app/", "http://LOCALHOST:3000/app#/route"},
		{"http://plain.example/", "http://plain.example:80", "http://plain.example"},
		{"https://docs.example/search?q=a&page=2", "https://docs.example/search/?q=a&page=2#r"},
	}
	for _, group := range same {
		want, ok := NormalizePageAddress(group[0])
		if !ok {
			t.Fatalf("%q has no key", group[0])
		}
		for _, other := range group[1:] {
			if got, ok := NormalizePageAddress(other); !ok || got != want {
				t.Errorf("%q = %q, want the key of %q: %q", other, got, group[0], want)
			}
		}
	}
}

func TestNormalizePageAddressKeepsWhatMakesAnotherPage(t *testing.T) {
	t.Parallel()
	different := [][2]string{
		{"https://docs.example/guide", "https://docs.example/Guide"},
		{"https://docs.example/guide", "http://docs.example/guide"},
		{"https://docs.example/guide", "https://docs.example:8443/guide"},
		{"https://docs.example/search?q=a", "https://docs.example/search?q=b"},
		{"https://docs.example/search", "https://docs.example/search?q=a"},
		{"https://docs.example/guide", "https://docs.example/guide/part"},
		{"https://docs.example/guide", "https://other.example/guide"},
		{"http://localhost:3000/", "http://localhost:3001/"},
	}
	for _, pair := range different {
		a, okA := NormalizePageAddress(pair[0])
		b, okB := NormalizePageAddress(pair[1])
		if !okA || !okB || a == b {
			t.Errorf("%q and %q must be two pages: %q %q", pair[0], pair[1], a, b)
		}
	}
}

func TestNormalizePageAddressHasNoKeyForWhatIsNotAPublicWebPage(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"", "about:blank", "file:///etc/hosts", "data:text/html,hi", "javascript:alert(1)", "https:///nohost", "not a url",
		"https://user:secret@docs.example/guide", "https://user@docs.example/guide",
	} {
		if key, ok := NormalizePageAddress(raw); ok {
			t.Errorf("%q must have no key, got %q", raw, key)
		}
	}
}

func TestMaskPageAddressDropsCredentialsFragmentAndSecrets(t *testing.T) {
	t.Parallel()
	cases := []struct{ raw, want string }{
		{"https://user:hunter2@docs.example/guide?page=2#access_token=abc", "https://docs.example/guide?page=2"},
		{"https://docs.example/cb?code=ABC123&state=xyz&lang=en", "https://docs.example/cb?code=***&state=***&lang=en"},
		{"https://docs.example/x?access_token=T1&refresh-token=T2&ApiKey=K&api_key=K2&X-Amz-Signature=S&sessionId=Z", "https://docs.example/x?access_token=***&refresh-token=***&ApiKey=***&api_key=***&X-Amz-Signature=***&sessionId=***"},
		{"https://docs.example/x?password=p%40ss&flag&q=keep", "https://docs.example/x?password=***&flag&q=keep"},
		{"https://docs.example/x?%74oken=hidden", "https://docs.example/x?%74oken=***"},
		{"http://localhost:3000/", "http://localhost:3000/"},
		{"HTTPS://Docs.Example/Path", "https://Docs.Example/Path"},
	}
	for _, c := range cases {
		if got := MaskPageAddress(c.raw); got != c.want {
			t.Errorf("MaskPageAddress(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
	for _, raw := range []string{"", "about:blank", "file:///etc/hosts", "javascript:alert(1)"} {
		if got := MaskPageAddress(raw); got != "" {
			t.Errorf("MaskPageAddress(%q) = %q, want nothing", raw, got)
		}
	}
	for _, secret := range []string{"hunter2", "abc", "ABC123", "xyz", "p%40ss", "hidden"} {
		for _, c := range cases {
			if strings.Contains(MaskPageAddress(c.raw), secret) {
				t.Errorf("%q leaks %q", c.raw, secret)
			}
		}
	}
}

func TestMaskPageAddressIsOneBoundedLine(t *testing.T) {
	t.Parallel()
	long := "https://docs.example/" + strings.Repeat("a", 2000)
	if got := MaskPageAddress(long); len([]rune(got)) != maxListedAddressLen || !strings.HasSuffix(got, "…") {
		t.Errorf("a long address is cut to %d runes: %d", maxListedAddressLen, len([]rune(got)))
	}
	if got := MaskPageAddress("https://docs.example/a\u0007b\nc"); strings.ContainsAny(got, "\u0007\n") {
		t.Errorf("control characters stay out: %q", got)
	}
}

func TestBestOpenPageOrdersOwnThenInViewThenRecentThenNewest(t *testing.T) {
	t.Parallel()
	const addr = "https://docs.example/guide"
	pages := []OpenPage{
		{PanelId: "p-old", TabId: "t-old", Url: addr, Recent: -1, Seq: 1},
		{PanelId: "p-new", TabId: "t-new", Url: addr, Recent: -1, Seq: 9},
		{PanelId: "p-recent", TabId: "t-recent", Url: addr + "/#frag", Recent: 0, Seq: 3},
		{PanelId: "p-older-recent", TabId: "t-older", Url: addr, Recent: 2, Seq: 5},
		{PanelId: "p-view", TabId: "t-view", Url: "HTTPS://DOCS.example:443/guide/", InView: true, Recent: 4, Seq: 2},
		{PanelId: "p-own", TabId: "t-own", Url: addr, Own: true, Recent: -1, Seq: 0},
		{PanelId: "p-other", TabId: "t-other", Url: "https://docs.example/other", Own: true, InView: true, Recent: 0, Seq: 99},
	}
	wantOrder := []string{"p-own", "p-view", "p-recent", "p-older-recent", "p-new", "p-old"}
	var got []string
	for _, page := range MatchingOpenPages(pages, addr) {
		got = append(got, page.PanelId)
	}
	if strings.Join(got, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("order = %v, want %v", got, wantOrder)
	}
	best, ok := BestOpenPage(pages, addr)
	if !ok || best.PanelId != "p-own" {
		t.Fatalf("best = %+v", best)
	}
	if _, ok := BestOpenPage(pages, "https://docs.example/nothing"); ok {
		t.Fatalf("nothing open at that address")
	}
	if _, ok := BestOpenPage(pages, "file:///x"); ok {
		t.Fatalf("an address that is not a page matches nothing")
	}
}
