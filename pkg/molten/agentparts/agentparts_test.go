// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentparts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixture struct {
	config string
	data   string
}

func makeFixture(t *testing.T) fixture {
	t.Helper()
	return fixture{config: t.TempDir(), data: t.TempDir()}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func (f fixture) addMod(t *testing.T, id string, withPart bool) string {
	t.Helper()
	dir := filepath.Join(ModsDir(f.config), id)
	manifest := map[string]any{"id": id, "name": id, "version": "1.0.0", "apiVersion": 1, "main": "main.js"}
	if withPart {
		manifest["agents"] = map[string]any{"claude-code": map[string]string{"folder": DefaultClaudeCodeFolder, "targetVersion": "2.1.289"}}
		writeFile(t, filepath.Join(dir, DefaultClaudeCodeFolder, ".claude-plugin", "plugin.json"), `{"name": "`+id+`"}`)
	}
	data, _ := json.Marshal(manifest)
	writeFile(t, filepath.Join(dir, "mod.json"), string(data))
	return dir
}

func (f fixture) setState(t *testing.T, enabled []string, trust map[string][]string) {
	t.Helper()
	state, _ := json.Marshal(map[string]any{"enabled": enabled})
	writeFile(t, filepath.Join(f.config, "molten", "mods.json"), string(state))
	entries := map[string]any{}
	for id, agents := range trust {
		entries[id] = map[string]any{"name": id, "agents": agents}
	}
	data, _ := json.Marshal(map[string]any{"trusted": entries})
	writeFile(t, filepath.Join(f.data, "molten", "trust.json"), string(data))
}

func stateOf(t *testing.T, f fixture, id string, safeMode bool) PartState {
	t.Helper()
	states, err := PartStates(f.config, f.data, safeMode)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range states {
		if state.Id == id {
			return state
		}
	}
	t.Fatalf("no part state for %s in %+v", id, states)
	return PartState{}
}

func TestParseAgents(t *testing.T) {
	ok := `{"agents": {"claude-code": {"folder": "agents/claude-code", "targetVersion": "2.1.289"}}}`
	part, err := ParseAgents([]byte(ok))
	if err != nil || part == nil || part.Folder != "agents/claude-code" || part.TargetVersion != "2.1.289" {
		t.Fatalf("valid part: %+v %v", part, err)
	}
	if part, err := ParseAgents([]byte(`{"id": "x"}`)); part != nil || err != nil {
		t.Fatalf("no agents: %+v %v", part, err)
	}
	bad := map[string]string{
		`{"agents": []}`:            `"agents" must be an object`,
		`{"agents": {"codex": {}}}`: `agent "codex" is not supported; supported: claude-code`,
		`{"agents": {"claude-code": {"targetVersion": "2.1.289"}}}`:                             `"agents.claude-code.folder" must be a non-empty string`,
		`{"agents": {"claude-code": {"folder": "../x", "targetVersion": "2.1.289"}}}`:           `no "." or ".." segment`,
		`{"agents": {"claude-code": {"folder": "/abs", "targetVersion": "2.1.289"}}}`:           `relative path`,
		`{"agents": {"claude-code": {"folder": "a/./b", "targetVersion": "2.1.289"}}}`:          `no "." or ".." segment`,
		`{"agents": {"claude-code": {"folder": "agents/claude-code", "targetVersion": "2.1"}}}`: `MAJOR.MINOR.PATCH`,
	}
	for manifest, want := range bad {
		_, err := ParseAgents([]byte(manifest))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: error %v, want %q", manifest, err, want)
		}
	}
}

func TestIgnoredModRelPath(t *testing.T) {
	cases := map[string]bool{
		"m/main.js":      false,
		"m/.git/config":  true,
		"m/main.js~":     true,
		"m/.main.js.swp": true,
		"m/agents/claude-code/.claude-plugin/plugin.json":                  false,
		"m/agents/claude-code/.claude-plugin":                              false,
		"m/agents/claude-code/.claude-plugin/types":                        true,
		"m/agents/claude-code/.claude-plugin/types/claude-code/index.d.ts": true,
		"m/agents/claude-code/.claude-plugin/plugin.json.tmp":              true,
		"m/agents/claude-code/.mcp.json":                                   false,
		"m/agents/claude-code/.gitignore":                                  false,
		"m/agents/claude-code/.mcp.json/x":                                 true,
		"m/agents/claude-code/hooks/register.tsx":                          false,
	}
	for rel, want := range cases {
		if got := IgnoredModRelPath(rel); got != want {
			t.Errorf("IgnoredModRelPath(%q) = %v, want %v", rel, got, want)
		}
	}
}

func TestPartStateMatrix(t *testing.T) {
	f := makeFixture(t)
	f.addMod(t, "on", true)
	f.addMod(t, "off", true)
	f.addMod(t, "modonly", true)
	f.addMod(t, "plain", false)
	broken := f.addMod(t, "broken", true)
	writeFile(t, filepath.Join(broken, DefaultClaudeCodeFolder, ".claude-plugin", "plugin.json"), `{"name": "other"}`)
	f.setState(t, []string{"on", "modonly", "broken", "plain"}, map[string][]string{
		"on": {"claude-code"}, "off": {"claude-code"}, "modonly": nil, "broken": {"claude-code"}, "plain": nil,
	})
	states, err := PartStates(f.config, f.data, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 4 {
		t.Fatalf("a mod without a part has no part state: %+v", states)
	}
	want := map[string]string{"on": PartStateActive, "off": PartStateDisabled, "modonly": PartStateUntrusted, "broken": PartStateInvalid}
	for id, state := range want {
		if got := stateOf(t, f, id, false); got.State != state {
			t.Errorf("%s: state %s (%s), want %s", id, got.State, got.Reason, state)
		}
	}
	if reason := stateOf(t, f, "broken", false).Reason; !strings.Contains(reason, `must be the mod id "broken"`) {
		t.Errorf("broken reason: %s", reason)
	}
	if got := stateOf(t, f, "on", true); got.State != PartStateSafeMode {
		t.Errorf("safe mode: %s", got.State)
	}
	if got := stateOf(t, f, "off", true); got.State != PartStateDisabled {
		t.Errorf("a disabled part stays disabled in safe mode: %s", got.State)
	}
}

func TestCheckPartFolderRefusesEscapes(t *testing.T) {
	f := makeFixture(t)
	dir := f.addMod(t, "m", false)
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, ".claude-plugin", "plugin.json"), `{"name": "m"}`)
	if err := os.MkdirAll(filepath.Join(dir, "agents"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "agents", "claude-code")); err != nil {
		t.Fatal(err)
	}
	_, err := CheckPartFolder(ModsDir(f.config), "m", &ClaudeCodePart{Folder: "agents/claude-code", TargetVersion: "1.0.0"})
	if err == nil || !strings.Contains(err.Error(), "outside the mod folder") {
		t.Fatalf("a symlink out of the mod must be refused: %v", err)
	}
	_, err = CheckPartFolder(ModsDir(f.config), "m", &ClaudeCodePart{Folder: "missing", TargetVersion: "1.0.0"})
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing folder: %v", err)
	}
	writeFile(t, filepath.Join(dir, "p", ".claude-plugin", "plugin.json"), `{"name": `)
	_, err = CheckPartFolder(ModsDir(f.config), "m", &ClaudeCodePart{Folder: "p", TargetVersion: "1.0.0"})
	if err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("bad JSON: %v", err)
	}
}

func TestSyncPointsSlotsAtPartsOrStubs(t *testing.T) {
	f := makeFixture(t)
	onDir := f.addMod(t, "on", true)
	f.addMod(t, "off", true)
	f.setState(t, []string{"on"}, map[string][]string{"on": {"claude-code"}, "off": {"claude-code"}})
	if err := SyncClaudeCodeSlots(f.config, f.data, false, true, "darwin"); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(SlotPath(f.data, "on"))
	if err != nil || target != filepath.Join(onDir, DefaultClaudeCodeFolder) {
		t.Fatalf("active slot -> %q (%v)", target, err)
	}
	target, _ = os.Readlink(SlotPath(f.data, "off"))
	if target != StubDir(f.data, "off") {
		t.Fatalf("disabled slot -> %q, want the stub", target)
	}
	var stub map[string]any
	data, err := os.ReadFile(filepath.Join(SlotPath(f.data, "off"), ".claude-plugin", "plugin.json"))
	if err != nil || json.Unmarshal(data, &stub) != nil || stub["name"] != "molten-off-off" {
		t.Fatalf("stub manifest through the slot: %s %v", data, err)
	}

	// Disabling retargets the same slot; the slot path never changes.
	f.setState(t, nil, map[string][]string{"on": {"claude-code"}})
	if err := SyncClaudeCodeSlots(f.config, f.data, false, false, "darwin"); err != nil {
		t.Fatal(err)
	}
	if target, _ := os.Readlink(SlotPath(f.data, "on")); target != StubDir(f.data, "on") {
		t.Fatalf("disabled part slot -> %q", target)
	}

	// Safe mode points every slot at its stub.
	f.setState(t, []string{"on"}, map[string][]string{"on": {"claude-code"}})
	SyncClaudeCodeSlots(f.config, f.data, true, false, "darwin")
	if target, _ := os.Readlink(SlotPath(f.data, "on")); target != StubDir(f.data, "on") {
		t.Fatalf("safe mode slot -> %q", target)
	}

	// A removed mod keeps a slot on its stub until the next start prunes it.
	if err := os.RemoveAll(filepath.Join(ModsDir(f.config), "off")); err != nil {
		t.Fatal(err)
	}
	SyncClaudeCodeSlots(f.config, f.data, false, false, "darwin")
	if target, _ := os.Readlink(SlotPath(f.data, "off")); target != StubDir(f.data, "off") {
		t.Fatalf("removed mod slot -> %q", target)
	}
	SyncClaudeCodeSlots(f.config, f.data, false, true, "darwin")
	if _, err := os.Lstat(SlotPath(f.data, "off")); !os.IsNotExist(err) {
		t.Fatalf("pruned slot still there: %v", err)
	}
	if _, err := os.Stat(StubDir(f.data, "off")); !os.IsNotExist(err) {
		t.Fatalf("pruned stub still there: %v", err)
	}
	entries, _ := os.ReadDir(SlotsDir(f.data))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temporary link left behind: %s", entry.Name())
		}
	}
}

func TestSyncLeavesARealFolderAlone(t *testing.T) {
	f := makeFixture(t)
	f.addMod(t, "on", true)
	f.setState(t, []string{"on"}, map[string][]string{"on": {"claude-code"}})
	writeFile(t, filepath.Join(SlotPath(f.data, "on"), "keep"), "x")
	if err := SyncClaudeCodeSlots(f.config, f.data, false, false, "darwin"); err == nil {
		t.Fatal("a folder at the slot path must be reported")
	}
	if _, err := os.Stat(filepath.Join(SlotPath(f.data, "on"), "keep")); err != nil {
		t.Fatal("the folder must be left alone")
	}
}

func TestSyncDoesNothingOnWindows(t *testing.T) {
	f := makeFixture(t)
	f.addMod(t, "on", true)
	f.setState(t, []string{"on"}, map[string][]string{"on": {"claude-code"}})
	SyncClaudeCodeSlots(f.config, f.data, false, true, "windows")
	if _, err := os.Lstat(SlotsDir(f.data)); !os.IsNotExist(err) {
		t.Fatal("no slot on Windows in v1")
	}
}

func TestPluginDirsValue(t *testing.T) {
	f := makeFixture(t)
	if got := PluginDirsValue("", f.data, false, "darwin"); got != "" {
		t.Fatalf("no slot and nothing inherited: %q", got)
	}
	if got := PluginDirsValue("/mine", f.data, false, "darwin"); got != "/mine" {
		t.Fatalf("the user's value is kept: %q", got)
	}
	f.addMod(t, "b", true)
	f.addMod(t, "a", true)
	f.setState(t, nil, nil)
	SyncClaudeCodeSlots(f.config, f.data, false, true, "darwin")
	a, b := SlotPath(f.data, "a"), SlotPath(f.data, "b")
	cases := []struct {
		inherited string
		safeMode  bool
		goos      string
		want      string
	}{
		{"", false, "darwin", a + ":" + b},
		{"/mine:/other", false, "darwin", "/mine:/other:" + a + ":" + b},
		{"/mine:/old/molten/agent-parts/claude-code/x:/mine", false, "darwin", "/mine:" + a + ":" + b},
		{"/mine:" + a, false, "darwin", "/mine:" + a + ":" + b},
		{"/mine:/old/molten/agent-parts/claude-code/x", true, "darwin", "/mine"},
		{"/old/molten/agent-parts/claude-code/x", true, "linux", ""},
		{`C:\mine`, false, "windows", `C:\mine`},
	}
	for _, c := range cases {
		if got := PluginDirsValue(c.inherited, f.data, c.safeMode, c.goos); got != c.want {
			t.Errorf("PluginDirsValue(%q, safe=%v, %s) = %q, want %q", c.inherited, c.safeMode, c.goos, got, c.want)
		}
	}
}
