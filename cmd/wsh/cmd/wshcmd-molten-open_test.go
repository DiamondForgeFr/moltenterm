// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestMoltenPageUrl(t *testing.T) {
	cases := map[string]string{
		"https://claude.ai/new": "https://claude.ai/new",
		"claude.ai":             "https://claude.ai",
		"localhost:3000/x":      "http://localhost:3000/x",
		"127.0.0.1:8080":        "http://127.0.0.1:8080",
		"about:blank":           "about:blank",
		"file:///tmp/a.html":    "file:///tmp/a.html",
		" example.com ":         "https://example.com",
	}
	for in, want := range cases {
		if got := moltenPageUrl(in); got != want {
			t.Errorf("moltenPageUrl(%q) = %q, want %q", in, got, want)
		}
	}
}
