// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// FR-BRW-007: programs call `$BROWSER <url>`, sometimes with options or more arguments; only the first argument that
// is not an option is read, and always as a positional argument.
func TestMoltenBrowserEnvArgs(t *testing.T) {
	prefix := []string{"/b/molten-open", "molten", "open", "--from-browser-env"}
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"/b/molten-open", "https://example.com"}, append(slices.Clone(prefix), "--", "https://example.com")},
		{[]string{"/b/molten-open", "https://a.example", "https://b.example"}, append(slices.Clone(prefix), "--", "https://a.example")},
		{[]string{"/b/molten-open", "--new-window", "https://example.com"}, append(slices.Clone(prefix), "--", "https://example.com")},
		{[]string{"/b/molten-open", "", "  ", "x.example"}, append(slices.Clone(prefix), "--", "x.example")},
		{[]string{"/b/molten-open"}, prefix},
		{[]string{"/b/molten-open", "-n"}, prefix},
	}
	for _, c := range cases {
		got := moltenBrowserEnvArgs(c.in)
		if strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("moltenBrowserEnvArgs(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMoltenBrowserEnvRouting(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"molten", "open", "--from-browser-env", "--", "https://example.com"})
	if err != nil || found != moltenOpenCmd {
		t.Fatalf("molten-open must run molten open: %v %v", found, err)
	}
}

func TestMoltenBrowserEnvPage(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "README.md")
	if err := os.WriteFile(file, nil, 0644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	cases := []struct {
		arg  string
		page string
		web  bool
	}{
		{"https://example.com/a?b=c#d", "https://example.com/a?b=c#d", true},
		{"HTTP://Example.com", "HTTP://Example.com", true},
		{"  https://example.com  ", "https://example.com", true},
		{"example.com/path", "https://example.com/path", true},
		{"localhost:3000", "http://localhost:3000", true},
		{"127.0.0.1:8080/x", "http://127.0.0.1:8080/x", true},
		{"example.com:8443/x", "https://example.com:8443/x", true},
		{"mailto:a@b.c", "", false},
		{"file:///etc/hosts", "", false},
		{"file:README.md", "", false},
		{"vscode://file/x", "", false},
		{"about:blank", "", false},
		{"javascript:alert(1)", "", false},
		{"ftp://example.com", "", false},
		{"https://", "", false},
		{"README.md", "", false},
		{"./README.md", "", false},
		{"../x/y.html", "", false},
		{"/etc/hosts", "", false},
		{"~/notes.html", "", false},
		{`C:\Users\x\page.html`, "", false},
		{"", "", false},
	}
	for _, c := range cases {
		page, web := moltenBrowserEnvPage(c.arg)
		if web != c.web || (c.web && page != c.page) {
			t.Errorf("moltenBrowserEnvPage(%q) = %q %v, want %q %v", c.arg, page, web, c.page, c.web)
		}
	}
}

func TestMoltenEnvWithout(t *testing.T) {
	env := []string{"A=1", "BROWSER=/x/molten-open", "BROWSERX=2", "B=3"}
	got := moltenEnvWithout(env, "BROWSER")
	if strings.Join(got, " ") != "A=1 BROWSERX=2 B=3" {
		t.Fatalf("got %v", got)
	}
}
