// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package onboarding

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func writeExe(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
}

func symlinkExe(t *testing.T, target string, link string) {
	t.Helper()
	writeExe(t, target)
	if err := os.MkdirAll(filepath.Dir(link), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestUninstallMatchesTheWayTheCopyWasInstalled(t *testing.T) {
	t.Setenv(TestUninstallDirEnv, "")
	home := t.TempDir()
	native := filepath.Join(home, ".local", "bin", "claude")
	symlinkExe(t, filepath.Join(home, ".local", "share", "claude", "versions", "9.9.9"), native)
	u, ok := matchUninstall("claude-code", home, native)
	if !ok || u.Method != UninstallNative || !u.Available || !strings.HasPrefix(u.Command, "rm -f ~/.local/bin/claude") {
		t.Fatalf("native claude: %+v %v", u, ok)
	}
	if len(u.Config) != 2 || u.Config[0] != "~/.claude" {
		t.Fatalf("native claude config: %+v", u.Config)
	}

	npmBin := filepath.Join(home, "npm", "bin", "claude")
	symlinkExe(t, filepath.Join(home, "npm", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"), npmBin)
	u, ok = matchUninstall("claude-code", home, npmBin)
	if !ok || u.Method != UninstallNpm || u.Command != "npm uninstall -g @anthropic-ai/claude-code" || !u.Available {
		t.Fatalf("npm claude: %+v %v", u, ok)
	}

	// Qwen's standalone qwen is a wrapper script: its runtime folder tells the method.
	qwen := filepath.Join(home, ".local", "bin", "qwen")
	writeExe(t, qwen)
	if _, ok := matchUninstall("qwen-code", home, qwen); ok {
		t.Fatal("a qwen without the standalone runtime matched the standalone uninstaller")
	}
	writeExe(t, filepath.Join(home, ".local", "lib", "qwen-code", "bin", "qwen"))
	u, ok = matchUninstall("qwen-code", home, qwen)
	if !ok || u.Method != UninstallNative || !strings.Contains(u.Command, "uninstall-qwen-standalone.sh") {
		t.Fatalf("standalone qwen: %+v %v", u, ok)
	}

	elsewhere := filepath.Join(home, "opt", "claude")
	writeExe(t, elsewhere)
	if u, ok := matchUninstall("claude-code", home, elsewhere); ok {
		t.Fatalf("a copy installed some other way matched %+v", u)
	}
}

func TestUninstallNeverRunsAnUndocumentedCommand(t *testing.T) {
	t.Setenv(TestUninstallDirEnv, "")
	home := t.TempDir()
	codex := filepath.Join(home, "npm", "bin", "codex")
	symlinkExe(t, filepath.Join(home, "npm", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), codex)
	u, ok := matchUninstall("codex", home, codex)
	if !ok || u.Available || u.Documented || len(u.Config) != 0 {
		t.Fatalf("codex's npm reverse is offered to run: %+v", u)
	}
	kimi := filepath.Join(home, ".kimi-code", "bin", "kimi")
	writeExe(t, kimi)
	u, ok = matchUninstall("kimi", home, kimi)
	if !ok || u.Available || u.Command != "" {
		t.Fatalf("kimi's script install has no command, yet: %+v", u)
	}
	for _, removal := range agentRemovalCatalog {
		for _, m := range removal.Methods {
			if m.Documented && m.Command != "" && !strings.HasPrefix(m.Source, "https://") {
				t.Fatalf("documented method without its source: %+v", m)
			}
		}
	}
	t.Setenv("HOME", home)
	t.Setenv(molten.LoginPathEnv, filepath.Dir(codex))
	molten.RefreshLoginPath()
	if _, err := StartCliUninstall("codex", false); err == nil {
		t.Fatal("an undocumented uninstall started")
	}
	if _, err := StartCliUninstall("rm -rf /", false); err == nil {
		t.Fatal("an unknown agent id was accepted")
	}
}

func TestUninstallTrashesTheSettingsOnlyWhenTicked(t *testing.T) {
	u := AgentUninstall{Method: UninstallNative, Command: "rm -f x", Config: []string{"~/.claude", "~/.claude.json"}}
	if configTrash(u, "/h", false) != nil {
		t.Fatal("unticked settings would be touched")
	}
	if configTrash(AgentUninstall{Method: UninstallNpm, Command: "npm un -g x"}, "/h", true) != nil {
		t.Fatal("settings the vendor does not document would be touched")
	}
	if configTrash(u, "/h", true) == nil {
		t.Fatal("ticked settings are not moved")
	}
	for id, removal := range agentRemovalCatalog {
		if len(removal.Config) > 0 && removal.ConfigHolds == "" {
			t.Fatalf("%s: settings folders without the words saying what they hold", id)
		}
	}
}

func trashedPath(home string, name string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, ".Trash", name)
	}
	return filepath.Join(home, ".local", "share", "Trash", "files", name)
}

func TestTrashAllMovesToTheTrashAndStopsAtTheFirstFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_DATA_HOME", "")
	settings := filepath.Join(home, ".claude")
	writeExe(t, filepath.Join(settings, "settings.json"))
	writeExe(t, filepath.Join(home, ".claude.json"))
	moved, failure := trashAll(home, []string{"~/.claude", "~/.missing", "~/.claude.json"})
	if failure != nil || len(moved) != 2 {
		t.Fatalf("moved %v, failure %v", moved, failure)
	}
	if _, err := os.Stat(settings); !os.IsNotExist(err) {
		t.Fatal("the settings folder is still in place")
	}
	if _, err := os.Stat(filepath.Join(trashedPath(home, ".claude"), "settings.json")); err != nil {
		t.Fatalf("the settings folder is not in the trash: %v", err)
	}
	if runtime.GOOS == "linux" {
		if _, err := os.Stat(filepath.Join(home, ".local", "share", "Trash", "info", ".claude.trashinfo")); err != nil {
			t.Fatalf("no trashinfo to put it back: %v", err)
		}
	}

	// A second .claude goes in under another name; a folder that cannot move stops the rest.
	writeExe(t, filepath.Join(settings, "settings.json"))
	locked := filepath.Join(home, "locked")
	writeExe(t, filepath.Join(locked, ".kimi-code", "config.toml"))
	if err := os.Chmod(locked, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0755) })
	moved, failure = trashAll(home, []string{"~/.claude", "~/locked/.kimi-code", "~/.claude.json"})
	if failure == nil || failure.Path != "~/locked/.kimi-code" || len(moved) != 1 {
		t.Fatalf("moved %v, failure %v", moved, failure)
	}
	if _, err := os.Stat(filepath.Join(locked, ".kimi-code", "config.toml")); err != nil {
		t.Fatal("the folder that could not move is gone")
	}
	if _, err := os.Stat(trashedPath(home, ".claude 2")); err != nil {
		t.Fatalf("the second .claude is not in the trash under another name: %v", err)
	}
}

func TestCliUninstallRunsTheFakeUninstaller(t *testing.T) {
	root := fakeInstallers(t, nil)
	home := os.Getenv("HOME")
	bin := filepath.Join(root, "bin")
	writeExe(t, filepath.Join(bin, "claude"))
	marks := filepath.Join(root, "marks")
	dir := filepath.Join(root, "uninstallers")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	script := "echo \"args: $*\" > '" + marks + "'\nrm -f '" + filepath.Join(bin, "claude") + "'\necho 'Claude Code removed'\n"
	if err := os.WriteFile(filepath.Join(dir, "claude-code.sh"), []byte(script), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(TestUninstallDirEnv, dir)
	t.Setenv("XDG_DATA_HOME", "")
	fakeHome := filepath.Join(dir, "home")
	writeExe(t, filepath.Join(fakeHome, ".claude", "settings.json"))
	writeExe(t, filepath.Join(home, ".claude", "settings.json"))
	t.Setenv(molten.LoginPathEnv, bin+":/usr/bin:/bin")
	molten.RefreshLoginPath()
	env := molten.AgentEnv{Home: home, DataDir: t.TempDir(), Getenv: os.Getenv}
	list := ListAgents(env, bin, "test")
	var entry AgentEntry
	for _, a := range list.Agents {
		if a.Id == "claude-code" {
			entry = a
		}
	}
	if entry.Uninstall == nil || !entry.Uninstall.Available || entry.Profile == nil || entry.Site == "" {
		t.Fatalf("claude entry = %+v", entry)
	}
	waitCliJobDone(t, "claude-code")
	status, err := StartCliUninstall("claude-code", true)
	if err != nil {
		t.Fatal(err)
	}
	if status.Kind != CliJobUninstall || strings.Contains(status.Command, "rm -rf") {
		t.Fatalf("start = %+v", status)
	}
	status = waitCliStatus(t, "claude-code", "end", ended)
	if status.State != CliInstallSucceeded || !strings.Contains(status.Output, "Claude Code removed") {
		t.Fatalf("status = %+v", status)
	}
	if len(status.Trashed) != 1 || status.Trashed[0] != "~/.claude" || status.TrashFailed != "" {
		t.Fatalf("trashed %v, failed %q", status.Trashed, status.TrashFailed)
	}
	if _, err := os.Stat(filepath.Join(fakeHome, ".claude")); !os.IsNotExist(err) {
		t.Fatal("the fake settings are still in place")
	}
	if _, err := os.Stat(trashedPath(fakeHome, ".claude")); err != nil {
		t.Fatalf("the fake settings are not in the trash: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude")); err != nil {
		t.Fatal("the HOME's own settings were touched by a fake uninstall")
	}
	raw, err := os.ReadFile(marks)
	if err != nil || strings.TrimSpace(string(raw)) != "args:" {
		t.Fatalf("the fake uninstaller got %q (%v)", raw, err)
	}
	if molten.LookPathIn("claude", bin) != "" {
		t.Fatal("the fake uninstaller left claude")
	}
}

func readLocale(t *testing.T, lang string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "frontend", "moltenterm-shell", "i18n", "locales", lang+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var rtn map[string]any
	if err := json.Unmarshal(raw, &rtn); err != nil {
		t.Fatal(err)
	}
	return rtn
}

func localeHas(m map[string]any, key string) bool {
	var cur any = m
	for _, part := range strings.Split(key, ".") {
		obj, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		cur = obj[part]
	}
	s, ok := cur.(string)
	return ok && s != ""
}

func TestAgentFactsKeysAreTranslated(t *testing.T) {
	en := readLocale(t, "en")
	fr := readLocale(t, "fr")
	for id, f := range agentFactsCatalog {
		if _, err := molten.FindAgent(id); err != nil {
			t.Fatalf("profile for an agent outside the catalog: %s", id)
		}
		keys := append([]string{f.GoodForKey, f.SpeedKey, f.LimitsKey}, f.StrengthKeys...)
		keys = append(keys, f.WeakKeys...)
		if f.NoteKey != "" {
			keys = append(keys, f.NoteKey)
		}
		if f.From != nil && f.From.NoteKey != "" {
			keys = append(keys, f.From.NoteKey)
		}
		for _, k := range keys {
			if !localeHas(en, k) || !localeHas(fr, k) {
				t.Fatalf("%s: key %q missing in en.json or fr.json", id, k)
			}
		}
		if f.CheckedOn == "" || !strings.HasPrefix(f.PricingPage, "https://") || !strings.HasPrefix(f.Site, "https://") {
			t.Fatalf("%s: facts without a date or official pages: %+v", id, f)
		}
		if f.FreeTier != "yes" && f.FreeTier != "no" && f.FreeTier != "notstated" {
			t.Fatalf("%s: free tier %q", id, f.FreeTier)
		}
	}
}
