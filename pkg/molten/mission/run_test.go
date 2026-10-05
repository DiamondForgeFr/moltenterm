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
