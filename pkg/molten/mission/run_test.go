// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package mission

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A Moltenterm opened from the Finder has a bare PATH: a program found only on the login shell's PATH must still run.
func TestExecRunnerUsesLoginPathOnly(t *testing.T) {
	bin := t.TempDir()
	script := filepath.Join(bin, "molten-fake-gh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho ok\n"), 0755); err != nil {
		t.Fatal(err)
	}
	saved := readLoginPath
	readLoginPath = func() string { return bin }
	t.Cleanup(func() { readLoginPath = saved })
	t.Setenv("PATH", "/usr/bin:/bin")

	out, err := ExecRunner(context.Background(), t.TempDir(), "molten-fake-gh")
	if err != nil {
		t.Fatalf("ExecRunner: %v", err)
	}
	if strings.TrimSpace(string(out)) != "ok" {
		t.Fatalf("output = %q", out)
	}
}

// A release step runs `molten release …`: the app's own bin folder comes first on the steps' PATH.
func TestCommandPathPutsTheAppBinFirst(t *testing.T) {
	bin := t.TempDir()
	savedLogin, savedBin := readLoginPath, appBinDir
	readLoginPath = func() string { return "/usr/bin:/bin" }
	appBinDir = func() string { return bin }
	t.Cleanup(func() { readLoginPath, appBinDir = savedLogin, savedBin })
	if got := commandPath(); got != bin+":/usr/bin:/bin" {
		t.Fatalf("PATH = %q", got)
	}
	appBinDir = func() string { return filepath.Join(bin, "missing") }
	if got := commandPath(); got != "/usr/bin:/bin" {
		t.Fatalf("PATH with no bin folder = %q", got)
	}
}

// #1146: git's advice lines say nothing about the failure; the line before them does.
func TestLastErrorLineSkipsGitHints(t *testing.T) {
	stderr := "The following paths are ignored by one of your .gitignore files:\n.molten\nhint: Use -f if you really want to add them.\nhint: Disable this message with \"git config set advice.addIgnoredFile false\"\n"
	if got := lastErrorLine(stderr); got != ".molten" {
		t.Fatalf("got %q", got)
	}
	if got := lastErrorLine("hint: only advice\n"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := lastErrorLine("fatal: one\nfatal: two\n"); got != "fatal: two" {
		t.Fatalf("got %q", got)
	}
}
