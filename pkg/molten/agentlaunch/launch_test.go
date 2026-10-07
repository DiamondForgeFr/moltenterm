// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writeExec(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
}

// DS-SHELL-045: the real binary is the first claude on PATH that is not a launcher: the launchers' folder, a link to
// a wsh (another MoltenTerm build's launcher) and relative entries are skipped.
func TestFindRealBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	root := t.TempDir()
	data := filepath.Join(root, "data", "bin")
	writeExec(t, filepath.Join(data, "wsh"))
	agents := filepath.Join(data, "agents")
	os.MkdirAll(agents, 0755)
	os.Symlink("../wsh", filepath.Join(agents, "claude"))
	gold := filepath.Join(root, "gold", "bin")
	writeExec(t, filepath.Join(gold, "wsh-0.1.0-darwin-arm64"))
	os.MkdirAll(filepath.Join(gold, "agents"), 0755)
	os.Symlink("../wsh-0.1.0-darwin-arm64", filepath.Join(gold, "agents", "claude"))
	local := filepath.Join(root, "home", ".local", "bin")
	versions := filepath.Join(root, "home", ".local", "share", "claude", "versions")
	writeExec(t, filepath.Join(versions, "2.1.292"))
	os.MkdirAll(local, 0755)
	os.Symlink(filepath.Join(versions, "2.1.292"), filepath.Join(local, "claude"))
	notExec := filepath.Join(root, "noexec")
	os.MkdirAll(notExec, 0755)
	os.WriteFile(filepath.Join(notExec, "claude"), nil, 0644)

	path := strings.Join([]string{agents, "relative/bin", "", filepath.Join(gold, "agents"), notExec, local, "/usr/bin"}, string(os.PathListSeparator))
	got, ok := FindRealBinary("claude", path, agents, IsLauncher)
	if !ok || got != filepath.Join(local, "claude") {
		t.Fatalf("got %q %v, want ~/.local/bin/claude", got, ok)
	}
	if _, ok := FindRealBinary("claude", strings.Join([]string{agents, filepath.Join(gold, "agents")}, string(os.PathListSeparator)), "", IsLauncher); ok {
		t.Fatalf("only launchers: nothing must be found")
	}
	if !IsLauncher(filepath.Join(agents, "claude")) || IsLauncher(filepath.Join(local, "claude")) {
		t.Fatalf("IsLauncher")
	}
}

func TestStepAsideReason(t *testing.T) {
	inPane := map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j"}
	cases := []struct {
		env  map[string]string
		args []string
		want string
	}{
		{inPane, nil, ""},
		{inPane, []string{"-p", "hello"}, ""},
		{map[string]string{"WAVETERM_BLOCKID": "b"}, nil, StepAsideOutsidePane},
		{map[string]string{"WAVETERM_JWT": "j"}, nil, StepAsideOutsidePane},
		{map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j", LaunchedVarName: "claude"}, nil, StepAsideNested},
		{map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j", "CLAUDECODE": "1"}, nil, StepAsideNested},
		{map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j", IntegrationVarName: "0"}, nil, StepAsideTurnedOff},
		{map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j", IntegrationVarName: "1"}, nil, ""},
		{inPane, []string{"--version"}, StepAsidePassThrough},
		{inPane, []string{"mcp", "list"}, StepAsidePassThrough},
	}
	for _, c := range cases {
		getenv := func(name string) string { return c.env[name] }
		if got := StepAsideReason(getenv, c.args, claudeAdapter{}); got != c.want {
			t.Errorf("env %v args %q: %q, want %q", c.env, c.args, got, c.want)
		}
	}
}

// NFR-SHELL-021: owner-only files named by their content, reused while unchanged, swept after a week unused.
func TestWriteAndSweepLaunchFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "molten", "agent-launch")
	now := time.Now()
	path, err := WriteLaunchFile(dir, "claude", []byte(`{"a":1}`), now)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := WriteLaunchFile(dir, "claude", []byte(`{"a":1}`), now); err != nil || again != path {
		t.Fatalf("same content, same file: %q %v", again, err)
	}
	other, _ := WriteLaunchFile(dir, "claude", []byte(`{"a":2}`), now)
	if other == path || !strings.HasPrefix(filepath.Base(path), "claude-") {
		t.Fatalf("names %q %q", path, other)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0600 {
			t.Fatalf("file mode %v", info.Mode().Perm())
		}
		if info, _ := os.Stat(dir); info.Mode().Perm() != 0700 {
			t.Fatalf("folder mode %v", info.Mode().Perm())
		}
	}
	old := now.Add(-8 * 24 * time.Hour)
	os.Chtimes(other, old, old)
	os.WriteFile(filepath.Join(dir, "keep.txt"), nil, 0600)
	os.Chtimes(filepath.Join(dir, "keep.txt"), old, old)
	SweepLaunchFiles(dir, now)
	if _, err := os.Stat(other); !os.IsNotExist(err) {
		t.Fatalf("an old file must go")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("a used file must stay: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "keep.txt")); err != nil {
		t.Fatalf("a file of another kind must stay")
	}
	os.Chtimes(path, old, old)
	if _, err := WriteLaunchFile(dir, "claude", []byte(`{"a":1}`), now); err != nil {
		t.Fatal(err)
	}
	SweepLaunchFiles(dir, now)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("reuse marks the file as used: %v", err)
	}
}
