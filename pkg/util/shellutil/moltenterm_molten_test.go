// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallMoltenCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows gets a copy; covered by utilfn.AtomicRenameCopy")
	}
	binDir := t.TempDir()
	wshPath := filepath.Join(binDir, "wsh")
	if err := os.WriteFile(wshPath, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	moltenPath := filepath.Join(binDir, "molten")
	if err := os.WriteFile(moltenPath, []byte("stale copy"), 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := InstallMoltenCommand(binDir, wshPath); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
		target, err := os.Readlink(moltenPath)
		if err != nil || target != "wsh" {
			t.Fatalf("install %d: molten links to %q (%v), want a relative link to wsh", i, target, err)
		}
	}
}
