// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
		target, err := os.Readlink(filepath.Join(binDir, AgentBinDirName, "claude"))
		if err != nil || target != filepath.Join("..", "wsh") {
			t.Fatalf("install %d: agents/claude links to %q (%v), want ../wsh", i, target, err)
		}
		if _, err := os.Stat(filepath.Join(binDir, AgentBinDirName, "claude")); err != nil {
			t.Fatalf("install %d: agents/claude does not resolve: %v", i, err)
		}
	}
}

// DS-SHELL-044: every shell's integration script names the agent launchers' folder, quoted for that shell, and only
// acts when the folder exists (a remote host never has it).
func TestRcFilesPutTheAgentLaunchersFirst(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin with space")
	if err := InitRcFiles(home, binDir); err != nil {
		t.Fatal(err)
	}
	agentDir := filepath.Join(binDir, AgentBinDirName)
	files := map[string]string{
		filepath.Join(home, ZshIntegrationDir, ".zshrc"):        HardQuote(agentDir),
		filepath.Join(home, BashIntegrationDir, ".bashrc"):      HardQuote(agentDir),
		filepath.Join(home, FishIntegrationDir, "wave.fish"):    HardQuoteFish(agentDir),
		filepath.Join(home, PwshIntegrationDir, "wavepwsh.ps1"): HardQuotePowerShell(agentDir),
	}
	for path, quoted := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if !strings.Contains(text, quoted) || !strings.Contains(text, "MOLTENTERM_AGENTBINDIR") {
			t.Errorf("%s does not put %s first on PATH", filepath.Base(path), quoted)
		}
	}
	zlogin, _ := os.ReadFile(filepath.Join(home, ZshIntegrationDir, ".zlogin"))
	if !strings.Contains(string(zlogin), "_moltenterm_agentpath") {
		t.Errorf(".zlogin must keep the launchers first after ~/.zlogin")
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
