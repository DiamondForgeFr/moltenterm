// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

func captureStderr(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	saved := WrappedStderr
	WrappedStderr = &buf
	t.Cleanup(func() { WrappedStderr = saved })
	return &buf
}

func writeNodeExec(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
}

// #1922: the launcher runs the agent of another Node version with a one-line note, or says what it searched and
// how to install the agent, and exits 127.
func TestFindMoltenLaunchBinaryOtherNodeVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix layouts")
	}
	home := filepath.Join(t.TempDir(), "home")
	nodes := filepath.Join(home, ".nvm", "versions", "node")
	writeNodeExec(t, filepath.Join(nodes, "v24.19.0", "bin", "node"))
	writeNodeExec(t, filepath.Join(nodes, "v22.15.0", "bin", "node"))
	env := map[string]string{"HOME": home, "PATH": filepath.Join(nodes, "v24.19.0", "bin")}
	getenv := func(name string) string { return env[name] }
	codex := agentlaunch.FindAdapter("codex")

	stderr := captureStderr(t)
	if _, ok := findMoltenLaunchBinary(codex, getenv); ok {
		t.Fatalf("nothing installed: found an agent")
	}
	out := stderr.String()
	for _, want := range []string{"codex: no Codex found (MoltenTerm launcher).", "nvm (v24.19.0, v22.15.0)", "To install it (for Node v24.19.0): npm install -g @openai/codex"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stderr %q lacks %q", out, want)
		}
	}
	if code := runMoltenAgentLaunch("codex", nil, getenv); code != moltenAgentLaunchMissingCode {
		t.Fatalf("exit %d, want %d", code, moltenAgentLaunchMissingCode)
	}

	writeNodeExec(t, filepath.Join(nodes, "v22.15.0", "bin", "codex"))
	stderr.Reset()
	real, ok := findMoltenLaunchBinary(codex, getenv)
	if !ok || real != filepath.Join(nodes, "v22.15.0", "bin", "codex") {
		t.Fatalf("got %q %v", real, ok)
	}
	if want := "codex: using Codex from Node v22.15.0 of nvm (not installed for v24.19.0, the Node version on PATH)\n"; stderr.String() != want {
		t.Fatalf("stderr %q, want %q", stderr.String(), want)
	}
}
