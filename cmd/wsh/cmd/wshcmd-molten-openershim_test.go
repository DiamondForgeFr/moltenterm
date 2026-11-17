// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

// #2176: only a call that opens one explicit http(s) page goes to molten-open; everything else keeps the real opener.
func TestMoltenOpenerShimPage(t *testing.T) {
	cases := []struct {
		tool string
		args []string
		page string
	}{
		{"open", []string{"https://example.com/a?b=c#d"}, "https://example.com/a?b=c#d"},
		{"open", []string{"HTTP://Example.com"}, "HTTP://Example.com"},
		{"open", []string{"http://localhost:8123/callback?code=x&state=y"}, "http://localhost:8123/callback?code=x&state=y"},
		{"open", []string{"-g", "https://example.com"}, "https://example.com"},
		{"open", []string{"--background", "https://example.com"}, "https://example.com"},
		{"open", []string{"-u", "https://example.com"}, "https://example.com"},
		{"open", []string{"-g", "-u", "https://example.com"}, "https://example.com"},
		{"xdg-open", []string{"https://example.com"}, "https://example.com"},
		{"open", nil, ""},
		{"open", []string{"README.md"}, ""},
		{"open", []string{"."}, ""},
		{"open", []string{"/tmp"}, ""},
		{"open", []string{"example.com"}, ""},
		{"open", []string{"-a", "Safari", "https://example.com"}, ""},
		{"open", []string{"-a", "Calculator"}, ""},
		{"open", []string{"-b", "com.example.app", "https://example.com"}, ""},
		{"open", []string{"-R", "https://example.com"}, ""},
		{"open", []string{"-W", "https://example.com"}, ""},
		{"open", []string{"https://example.com", "--args", "x"}, ""},
		{"open", []string{"https://a.example", "https://b.example"}, ""},
		{"open", []string{"-u"}, ""},
		{"open", []string{"mailto:someone@example.com"}, ""},
		{"open", []string{"file:///tmp/x.html"}, ""},
		{"open", []string{"vscode://file/tmp"}, ""},
		{"open", []string{"https://"}, ""},
		{"open", []string{"http:example.com"}, ""},
		{"open", []string{" https://example.com"}, ""},
		{"xdg-open", []string{"--version"}, ""},
		{"xdg-open", []string{"https://example.com", "x"}, ""},
		{"xdg-open", []string{"/tmp/report.pdf"}, ""},
	}
	for _, c := range cases {
		page, ok := moltenOpenerShimPage(c.tool, c.args)
		if page != c.page || ok != (c.page != "") {
			t.Errorf("moltenOpenerShimPage(%s, %q) = %q, %v; want %q", c.tool, c.args, page, ok, c.page)
		}
	}
}

func TestMoltenOpenerShimArgs(t *testing.T) {
	names := shellutil.OpenerShimNames()
	if len(names) == 0 {
		t.Skip("no opener shim on " + runtime.GOOS)
	}
	tool := names[0]
	shim := "/d/bin/agents/" + tool
	got := moltenRewriteArgs([]string{shim, "https://example.com/x"})
	want := []string{shim, "molten", "open", "--from-browser-env", "--", "https://example.com/x"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("web page: got %q, want %q", got, want)
	}
	got = moltenRewriteArgs([]string{shim, "-a", "Some App", "--", "x"})
	want = []string{shim, "molten", "openershim", "--tool", tool, "--", "-a", "Some App", "--", "x"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("other call: got %q, want %q", got, want)
	}
	found, _, err := rootCmd.Find([]string{"molten", "openershim", "--tool", tool, "--", "-a", "x"})
	if err != nil || found != moltenOpenerShimCmd {
		t.Fatalf("openershim must be a molten command: %v %v", found, err)
	}
	other := "open"
	if tool == "open" {
		other = "xdg-open"
	}
	if got := moltenOpenerShimArgs([]string{"/x/" + other, "https://example.com"}, other); got != nil {
		t.Errorf("%s is no shim on %s: got %q", other, runtime.GOOS, got)
	}
}

// The real opener is found by absolute path, past every MoltenTerm shim on PATH (the launchers' folder, the openers
// folder or another build's), so neither the shim nor molten-open's fallback ever calls itself.
func TestMoltenRealOpener(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no opener shim on Windows")
	}
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	openers := filepath.Join(binDir, shellutil.OpenerBinDirName)
	agents := filepath.Join(binDir, agentlaunch.AgentBinDirName)
	system := filepath.Join(root, "system")
	for _, dir := range []string{openers, agents, system} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(binDir, "wsh"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{openers, agents} {
		if err := os.Symlink(filepath.Join("..", "wsh"), filepath.Join(dir, "open")); err != nil {
			t.Fatal(err)
		}
	}
	real := filepath.Join(system, "open")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(agentlaunch.AgentBinDirVarName, "")
	t.Setenv("PATH", strings.Join([]string{openers, agents, system}, string(filepath.ListSeparator)))
	got, found := moltenRealOpener("open")
	if !found || got != real {
		t.Fatalf("got %q (%v), want %q", got, found, real)
	}
	t.Setenv("PATH", strings.Join([]string{openers, agents}, string(filepath.ListSeparator)))
	if got, found := moltenRealOpener("open"); found && (strings.HasPrefix(got, openers) || strings.HasPrefix(got, agents)) {
		t.Fatalf("only shims on PATH: got %q, never a shim", got)
	}
}
