// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package onboarding

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func TestUninstallCommandLineAddsTheSettingsOnlyWhenTicked(t *testing.T) {
	u := AgentUninstall{Method: UninstallNative, Command: "rm -f x", Config: []string{"~/.claude", "~/.claude.json"}}
	if got := uninstallCommandLine("claude-code", u, "/h", false); got != "rm -f x" {
		t.Fatalf("unticked: %q", got)
	}
	if got := uninstallCommandLine("claude-code", u, "/h", true); got != "rm -f x && rm -rf '/h/.claude' '/h/.claude.json'" {
		t.Fatalf("ticked: %q", got)
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
	if status.Kind != CliJobUninstall || !strings.HasSuffix(status.Command, "--config") {
		t.Fatalf("start = %+v", status)
	}
	status = waitCliStatus(t, "claude-code", "end", ended)
	if status.State != CliInstallSucceeded || !strings.Contains(status.Output, "Claude Code removed") {
		t.Fatalf("status = %+v", status)
	}
	raw, err := os.ReadFile(marks)
	if err != nil || strings.TrimSpace(string(raw)) != "args: --config" {
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
