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
