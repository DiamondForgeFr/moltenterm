// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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

// DS-SHELL-074: the refresh file puts the launchers' folder back first on PATH (once, dropping other copies) and
// reports the generation once, in every shell that sources it from a hook function.
func TestMoltenRefreshFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no zsh, bash or fish refresh on Windows")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, "bin with space")
	agentDir := filepath.Join(binDir, AgentBinDirName)
	if err := os.MkdirAll(agentDir, 0755); err != nil {
		t.Fatal(err)
	}
	makeIntegrationDirs(t, home)
	if err := InitRcFiles(home, binDir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(ZshIntegrationDir, ".zshrc"), filepath.Join(BashIntegrationDir, ".bashrc"), filepath.Join(FishIntegrationDir, "wave.fish")} {
		data, _ := os.ReadFile(filepath.Join(home, name))
		if !strings.Contains(string(data), "_moltenterm_refresh") || !strings.Contains(string(data), MoltenRefreshDir) {
			t.Errorf("%s does not register the refresh hook", name)
		}
	}
	shFile := filepath.Join(home, MoltenRefreshDir, moltenRefreshShName)
	fishFile := filepath.Join(home, MoltenRefreshDir, moltenRefreshFishName)
	report := "\x1b]16162;MOLTEN;{\"gen\":" + strconv.Itoa(MoltenShellGeneration) + "}\x07"
	posix := `f() { source "$1"; }; PATH="/usr/bin:$2:/bin"; f "$1"; printf '[%s]\n' "$PATH"; f "$1"; PATH="/usr/bin:/bin"; f "$1"; printf '[%s]\n' "$PATH"`
	want := report + "[" + agentDir + ":/usr/bin:/bin]\n[" + agentDir + ":/usr/bin:/bin]\n"
	for _, shell := range []string{"zsh", "bash"} {
		path, err := exec.LookPath(shell)
		if err != nil {
			t.Logf("%s not installed", shell)
			continue
		}
		args := []string{"-c", posix, shell, shFile, agentDir}
		if shell == "zsh" {
			args = append([]string{"-f"}, args...)
		} else {
			args = append([]string{"--norc", "--noprofile"}, args...)
		}
		cmd := exec.Command(path, args...)
		cmd.Env = []string{"HOME=" + home, "TERM=xterm-256color"}
		out, err := cmd.CombinedOutput()
		if err != nil || string(out) != want {
			t.Errorf("%s: got %q (%v), want %q", shell, out, err, want)
		}
	}
	if fish, err := exec.LookPath("fish"); err == nil {
		script := `function f; source $argv[1]; end; set -gx PATH /usr/bin $argv[2] /bin; f $argv[1]; printf '[%s]\n' (string join : $PATH); f $argv[1]; set -gx PATH /usr/bin /bin; f $argv[1]; printf '[%s]\n' (string join : $PATH)`
		cmd := exec.Command(fish, "--no-config", "-c", script, fishFile, agentDir)
		cmd.Env = []string{"HOME=" + home, "TERM=xterm-256color"}
		out, err := cmd.CombinedOutput()
		wantFish := report + "[" + agentDir + ":/usr/bin:/bin]\n[" + agentDir + ":/usr/bin:/bin]\n"
		if err != nil || string(out) != wantFish {
			t.Errorf("fish: got %q (%v), want %q", out, err, wantFish)
		}
	}
	// Rewriting the same content keeps the file (shells may be reading it); a remote host has no launchers' folder.
	before, _ := os.Stat(shFile)
	if err := InitRcFiles(home, binDir); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(shFile)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Errorf("unchanged refresh file was rewritten")
	}
	if err := os.RemoveAll(agentDir); err != nil {
		t.Fatal(err)
	}
	if bash, err := exec.LookPath("bash"); err == nil {
		out, err := exec.Command(bash, "--norc", "-c", `PATH=/usr/bin:/bin; source "$1"; printf '[%s]' "$PATH"`, "bash", shFile).CombinedOutput()
		if err != nil || string(out) != "[/usr/bin:/bin]" {
			t.Errorf("without the launchers' folder: got %q (%v)", out, err)
		}
	}
}

// The hook keeps the exit status the prompt and the other hooks read.
func TestMoltenRefreshHookKeepsStatus(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("no bash")
	}
	home := t.TempDir()
	makeIntegrationDirs(t, home)
	if err := InitRcFiles(home, filepath.Join(home, "bin")); err != nil {
		t.Fatal(err)
	}
	rc, _ := os.ReadFile(filepath.Join(home, BashIntegrationDir, ".bashrc"))
	start := strings.Index(string(rc), "_moltenterm_refresh() {")
	end := strings.Index(string(rc)[start:], "\n}\n")
	if start < 0 || end < 0 {
		t.Fatal("no _moltenterm_refresh function in .bashrc")
	}
	fn := string(rc)[start : start+end+3]
	pre := strings.Index(string(rc), "_moltenterm_refresh_preexec() {")
	preEnd := strings.Index(string(rc)[pre:], "\n}\n")
	if pre < 0 || preEnd < 0 {
		t.Fatal("no _moltenterm_refresh_preexec function in .bashrc")
	}
	fn += "\n" + string(rc)[pre:pre+preEnd+3]
	out, err := exec.Command(bash, "--norc", "-c", fn+"(exit 3); _moltenterm_refresh; echo $?; (exit 3); _moltenterm_refresh_preexec; echo $?").CombinedOutput()
	if err != nil || strings.Fields(string(out))[0] != "3" || strings.Fields(string(out))[1] != "0" {
		t.Errorf("got %q (%v), want the status 3 kept at the prompt and 0 before a command (extdebug skips it otherwise)", out, err)
	}
}

// InitRcFiles creates its folders once per process (wavebase.CacheEnsureDir): a second test home needs them made.
func makeIntegrationDirs(t *testing.T, home string) {
	for _, dir := range []string{ZshIntegrationDir, BashIntegrationDir, FishIntegrationDir, PwshIntegrationDir} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0755); err != nil {
			t.Fatal(err)
		}
	}
}
