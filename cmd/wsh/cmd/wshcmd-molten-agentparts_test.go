// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
)

// The output of `claude plugin validate --json` on Claude Code 2.1.289 for a part with a broken hooks file.
const moltenClaudeValidateFixture = `{
  "success": false,
  "strict": false,
  "target": "/cfg/mods/band/agents/claude-code/.claude-plugin/plugin.json",
  "manifest": {
    "file": "/cfg/mods/band/agents/claude-code/.claude-plugin/plugin.json",
    "type": "plugin",
    "errors": [],
    "warnings": [
      {"path": "author", "message": "No author information provided. Consider adding author details for plugin attribution", "code": null},
      {"path": "name", "message": "Plugin name \"a.b\" is not kebab-case. Claude Code accepts it, but the Claude.ai marketplace sync requires kebab-case", "code": null},
      {"path": "description", "message": "No description provided.", "code": null}
    ],
    "notes": []
  },
  "contents": [
    {
      "file": "/cfg/mods/band/agents/claude-code/hooks/hooks.json",
      "type": "hooks",
      "errors": [{"path": "modules.0", "message": "./missing.ts does not exist", "code": null}],
      "warnings": [],
      "notes": ["./register.ts hooks: tool.call{tool=Bash}"]
    }
  ]
}`

const moltenClaudeNoManifestFixture = `{
  "success": false,
  "target": "/cfg/mods/band/agents/claude-code",
  "manifest": {
    "file": "/cfg/mods/band/agents/claude-code",
    "type": "plugin",
    "errors": [{"path": "directory", "message": "No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json", "code": null}],
    "warnings": [],
    "notes": []
  },
  "contents": []
}`

func TestMoltenParseClaudeValidate(t *testing.T) {
	part := "/cfg/mods/band/agents/claude-code"
	problems, err := moltenParseClaudeValidate([]byte(moltenClaudeValidateFixture), part, "agents/claude-code")
	if err != nil {
		t.Fatal(err)
	}
	want := []MoltenValidationProblem{
		{File: "agents/claude-code/.claude-plugin/plugin.json", Message: "claude plugin validate: description: No description provided.", Severity: MoltenSeverityWarning},
		{File: "agents/claude-code/hooks/hooks.json", Message: "claude plugin validate: modules.0: ./missing.ts does not exist"},
	}
	if len(problems) != len(want) {
		t.Fatalf("problems %+v", problems)
	}
	for i := range want {
		if problems[i] != want[i] {
			t.Errorf("problem %d: %+v, want %+v", i, problems[i], want[i])
		}
	}
	problems, _ = moltenParseClaudeValidate([]byte(moltenClaudeNoManifestFixture), part, "agents/claude-code")
	if len(problems) != 1 || problems[0].File != "agents/claude-code" || !strings.Contains(problems[0].Message, "No manifest found") || problems[0].Severity != "" {
		t.Fatalf("no manifest: %+v", problems)
	}
	if _, err := moltenParseClaudeValidate([]byte("oops"), part, "agents/claude-code"); err == nil {
		t.Fatal("output that is not JSON must be reported")
	}
}

func TestMoltenClaudeVersion(t *testing.T) {
	if v, err := moltenParseClaudeVersion("2.1.289 (Claude Code)\n"); err != nil || v != "2.1.289" {
		t.Fatalf("parse: %q %v", v, err)
	}
	if _, err := moltenParseClaudeVersion("unknown"); err == nil {
		t.Fatal("no version must fail")
	}
	if moltenVersionWarning("2.1.289", "2.1.289") != "" {
		t.Fatal("the same version is no warning")
	}
	w := moltenVersionWarning("2.1.289", "2.1.300")
	if !strings.Contains(w, "targets Claude Code 2.1.289, installed 2.1.300") || !strings.Contains(w, "early access") {
		t.Fatalf("warning %q", w)
	}
}

func stubClaude(t *testing.T, onPath bool, validate string, version string) {
	t.Helper()
	savedRun, savedOnPath := moltenRunClaude, moltenClaudeOnPath
	t.Cleanup(func() { moltenRunClaude, moltenClaudeOnPath = savedRun, savedOnPath })
	moltenClaudeOnPath = func() bool { return onPath }
	moltenRunClaude = func(timeout time.Duration, args ...string) ([]byte, int, error) {
		if args[0] == "--version" {
			return []byte(version + " (Claude Code)\n"), 0, nil
		}
		return []byte(validate), 1, nil
	}
}

func TestMoltenCheckClaudeCodePart(t *testing.T) {
	part := t.TempDir()
	result := func() *MoltenValidationResult {
		return &MoltenValidationResult{Id: "band", Ok: true, Problems: []MoltenValidationProblem{}, Agents: map[string]MoltenAgentPartInfo{
			"claude-code": {Folder: "agents/claude-code", Path: part, TargetVersion: "2.1.289"},
		}}
	}

	stubClaude(t, false, "", "")
	r := result()
	moltenCheckClaudeCodePart(r)
	if !r.Ok || len(r.Problems) != 1 || !strings.Contains(r.Problems[0].Message, "claude is not on the PATH: the Claude Code part was not checked") {
		t.Fatalf("without claude: %+v", r)
	}

	stubClaude(t, true, strings.ReplaceAll(moltenClaudeValidateFixture, "/cfg/mods/band/agents/claude-code", part), "2.1.300")
	r = result()
	moltenCheckClaudeCodePart(r)
	if r.Ok {
		t.Fatalf("an error from claude plugin validate must fail: %+v", r)
	}
	out := formatMoltenValidation([]MoltenValidationResult{*r})
	for _, want := range []string{"band: agents/claude-code/hooks/hooks.json: claude plugin validate: modules.0", "band: warning: mod.json: the Claude Code part targets Claude Code 2.1.289, installed 2.1.300"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}

	stubClaude(t, true, `{"success": true, "manifest": {"file": "`+part+`/.claude-plugin/plugin.json", "errors": [], "warnings": []}, "contents": []}`, "2.1.300")
	r = result()
	moltenCheckClaudeCodePart(r)
	if !r.Ok || !strings.HasPrefix(formatMoltenValidation([]MoltenValidationResult{*r}), "band: ok (1 warning)\n") {
		t.Fatalf("warnings never fail: %s", formatMoltenValidation([]MoltenValidationResult{*r}))
	}

	plain := &MoltenValidationResult{Id: "plain", Ok: true}
	moltenCheckClaudeCodePart(plain)
	if len(plain.Problems) != 0 {
		t.Fatal("a mod without a part is not checked")
	}
}

func TestMoltenPartNotes(t *testing.T) {
	active := MoltenPartStatus{State: agentparts.PartStateActive}
	off := MoltenPartStatus{State: agentparts.PartStateDisabled}
	note := moltenPartNote("band", off, active, true, "darwin")
	if note == nil || note.TakesEffect != MoltenPartTakesEffectNextSession || !strings.Contains(note.Message, "loads in the next Claude Code session") || !strings.Contains(note.Message, "claude --continue") {
		t.Fatalf("enable: %+v", note)
	}
	note = moltenPartNote("band", off, active, false, "darwin")
	if note == nil || note.TakesEffect != MoltenPartTakesEffectNewTerminal || !strings.Contains(note.Message, "new MoltenTerm terminal") {
		t.Fatalf("enable in a terminal without the slot: %+v", note)
	}
	note = moltenPartNote("band", active, off, true, "darwin")
	if note == nil || note.State != agentparts.PartStateDisabled || !strings.Contains(note.Message, "stops loading at the next Claude Code session") {
		t.Fatalf("disable: %+v", note)
	}
	note = moltenPartNote("band", active, MoltenPartStatus{}, true, "darwin")
	if note == nil || note.State != "none" {
		t.Fatalf("remove: %+v", note)
	}
	note = moltenPartNote("band", off, MoltenPartStatus{State: agentparts.PartStateInvalid, Reason: "bad name"}, true, "darwin")
	if note == nil || !strings.Contains(note.Message, "stays off: bad name") {
		t.Fatalf("invalid: %+v", note)
	}
	note = moltenPartNote("band", off, MoltenPartStatus{State: agentparts.PartStateUntrusted}, true, "darwin")
	if note == nil || !strings.Contains(note.Message, "you did not trust it") {
		t.Fatalf("untrusted: %+v", note)
	}
	note = moltenPartNote("band", off, MoltenPartStatus{State: agentparts.PartStateSafeMode}, true, "darwin")
	if note == nil || !strings.Contains(note.Message, "safe mode") {
		t.Fatalf("safe mode: %+v", note)
	}
	if moltenPartNote("band", active, active, true, "darwin") != nil || moltenPartNote("plain", MoltenPartStatus{}, MoltenPartStatus{}, true, "darwin") != nil {
		t.Fatal("no change, no note")
	}
	if moltenPartNote("band", MoltenPartStatus{}, off, true, "darwin") != nil {
		t.Fatal("a part that was never on needs no note when it stays off")
	}
	if note := moltenPartNote("band", off, active, true, "windows"); note == nil || !strings.Contains(note.Message, "Windows") {
		t.Fatalf("windows: %+v", note)
	}
}

func TestMoltenSettingsOverride(t *testing.T) {
	dir := t.TempDir()
	if moltenSettingsOverride(dir) != "" {
		t.Fatal("no settings file, no warning")
	}
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"env": {"OTHER": "1"}}`), 0644)
	if moltenSettingsOverride(dir) != "" {
		t.Fatal("other env, no warning")
	}
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"env": {"CLAUDE_CODE_PLUGIN_DIRS": "/x"}}`), 0644)
	if w := moltenSettingsOverride(dir); !strings.Contains(w, "replaces the folders MoltenTerm gives Claude Code") {
		t.Fatalf("warning %q", w)
	}
}

func TestMoltenShellOverride(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv(agentparts.PluginDirsVarName, "/mine")
	if moltenShellOverride(dataDir, false, "darwin") != "" {
		t.Fatal("no slot, no warning")
	}
	slot := agentparts.SlotPath(dataDir, "band")
	os.MkdirAll(filepath.Dir(slot), 0755)
	os.Symlink(t.TempDir(), slot)
	if w := moltenShellOverride(dataDir, false, "darwin"); !strings.Contains(w, "shell startup file") {
		t.Fatalf("slots exist but the terminal carries none: %q", w)
	}
	if moltenShellOverride(dataDir, true, "darwin") != "" {
		t.Fatal("safe mode carries no slot on purpose")
	}
	t.Setenv(agentparts.PluginDirsVarName, "/mine"+string(os.PathListSeparator)+slot)
	if moltenShellOverride(dataDir, false, "darwin") != "" {
		t.Fatal("the terminal carries the slot")
	}
	if !moltenCarriesSlot(dataDir, "band") || moltenCarriesSlot(dataDir, "other") {
		t.Fatal("moltenCarriesSlot")
	}
}

func TestMoltenNewModWithClaudeCodePart(t *testing.T) {
	configDir := t.TempDir()
	dir, err := moltenNewMod(configDir, "band", "Band", "", "2.1.289")
	if err != nil {
		t.Fatal(err)
	}
	part, err := agentparts.ReadClaudeCodePart(moltenModsDir(configDir), "band")
	if err != nil || part == nil || part.Folder != "agents/claude-code" || part.TargetVersion != "2.1.289" {
		t.Fatalf("manifest part: %+v %v", part, err)
	}
	if _, err := agentparts.CheckPartFolder(moltenModsDir(configDir), "band", part); err != nil {
		t.Fatalf("the scaffolded part must be valid: %v", err)
	}
	var hooks map[string][]string
	data, _ := os.ReadFile(filepath.Join(dir, "agents", "claude-code", "hooks", "hooks.json"))
	if json.Unmarshal(data, &hooks) != nil || hooks["modules"][0] != "./register.ts" {
		t.Fatalf("hooks.json: %s", data)
	}
	register, _ := os.ReadFile(filepath.Join(dir, "agents", "claude-code", "hooks", "register.ts"))
	if !strings.Contains(string(register), "export const register: Register") || strings.Contains(string(register), "{{") {
		t.Fatalf("register.ts:\n%s", register)
	}
	gitignore, _ := os.ReadFile(filepath.Join(dir, "agents", "claude-code", ".gitignore"))
	if string(gitignore) != ".claude-plugin/types/\n" {
		t.Fatalf(".gitignore: %q", gitignore)
	}
	if _, err := moltenNewMod(configDir, "bad", "", "", "2.1"); err == nil {
		t.Fatal("a version that is not X.Y.Z must be refused")
	}
	plain, _ := moltenNewMod(configDir, "plain", "", "", "")
	if _, err := os.Stat(filepath.Join(plain, "agents")); !os.IsNotExist(err) {
		t.Fatal("no part without --claude-code")
	}
}

func TestMoltenTrustNeeded(t *testing.T) {
	withPart := MoltenTrustEntry{Name: "b", Agents: []string{"claude-code"}}
	cases := []struct {
		trusted bool
		entry   MoltenTrustEntry
		hasPart bool
		want    string
	}{
		{false, MoltenTrustEntry{}, false, moltenTrustNeedsMod},
		{false, MoltenTrustEntry{}, true, moltenTrustNeedsMod},
		{true, MoltenTrustEntry{Name: "b"}, false, moltenTrustNeedsNothing},
		{true, MoltenTrustEntry{Name: "b"}, true, moltenTrustNeedsPart},
		{true, withPart, true, moltenTrustNeedsNothing},
	}
	for _, c := range cases {
		if got := moltenTrustNeeded(c.trusted, c.entry, c.hasPart); got != c.want {
			t.Errorf("trusted=%v agents=%v part=%v: %s, want %s", c.trusted, c.entry.Agents, c.hasPart, got, c.want)
		}
	}
	dataDir := t.TempDir()
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	moltenSetTrustedAgents(dataDir, "b", "B", []string{"claude-code"}, now)
	entry, ok, err := moltenReadTrustEntry(dataDir, "b")
	if err != nil || !ok || !moltenTrustCovers(entry, "claude-code") {
		t.Fatalf("trust entry: %+v %v %v", entry, ok, err)
	}
	data, _ := os.ReadFile(moltenTrustFile(dataDir))
	if !strings.Contains(string(data), `"agents": [`) {
		t.Fatalf("trust.json: %s", data)
	}
}

func TestFormatMoltenModListWithParts(t *testing.T) {
	out := formatMoltenModList(&MoltenModList{Mods: []MoltenModStatus{
		{Id: "band", State: "active", Commands: []string{}, Agents: map[string]MoltenPartStatus{"claude-code": {State: "active", TargetVersion: "2.1.289"}}},
		{Id: "bad", State: "active", Commands: []string{}, Agents: map[string]MoltenPartStatus{"claude-code": {State: "invalid", Reason: "no plugin.json", TargetVersion: "2.1.289"}}},
		{Id: "plain", State: "active", Commands: []string{}},
	}})
	for _, want := range []string{"CLAUDE CODE PARTS", "  band: active (targets 2.1.289)\n", "  bad: invalid: no plugin.json (targets 2.1.289)\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("mod list lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "  plain:") {
		t.Fatal("a mod without a part has no part line")
	}
}
