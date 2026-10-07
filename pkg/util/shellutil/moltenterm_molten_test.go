// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
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
		for _, name := range []string{"molten", "molten-open"} {
			target, err := os.Readlink(filepath.Join(binDir, name))
			if err != nil || target != "wsh" {
				t.Fatalf("install %d: %s links to %q (%v), want a relative link to wsh", i, name, target, err)
			}
		}
	}
}

func TestMoltenOpenPath(t *testing.T) {
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	defer func() { wavebase.DataHome_VarCache = saved }()
	if got := MoltenOpenPath(); got != "" {
		t.Fatalf("not installed: got %q, want none", got)
	}
	binDir := filepath.Join(dataDir, WaveHomeBinDir)
	if err := os.MkdirAll(binDir, 0755); err != nil {
		t.Fatal(err)
	}
	name := "molten-open"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(binDir, name), nil, 0755); err != nil {
		t.Fatal(err)
	}
	if got := MoltenOpenPath(); got != filepath.Join(binDir, name) || !filepath.IsAbs(got) {
		t.Fatalf("installed: got %q, want the absolute path in the bin dir", got)
	}
}
