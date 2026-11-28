// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func oldMoltenCommand(state string) string {
	return `[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state ` + state + ` --agent claude || true`
}

// The settings.json of a developer who pasted an older agent-states.md (#2595's report): `molten agent state` on four
// events, next to their own hooks, one of them in the same group as MoltenTerm's, and the coffee approvals' hook.
func olderClaudeSettings() string {
	return `{
  "model": "opus",
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "` + oldMoltenCommand("working") + `" }] }],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "lint.sh" }] },
      { "hooks": [{ "type": "command", "command": "` + oldMoltenCommand("working") + `" }, { "type": "command", "command": "log-tool.sh", "timeout": 5 }] }
    ],
    "Notification": [{ "hooks": [{ "type": "command", "command": "` + oldMoltenCommand("waiting") + `" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "` + oldMoltenCommand("done") + `" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": ` + jsonText(ClaudePermissionHookCommand) + ` }] }]
  },
  "permissions": { "allow": ["Bash(ls:*)"] }
}
`
}

func claudeTestOffer(t *testing.T, env AgentEnv) AgentHookOffer {
	t.Helper()
	return MakeAgentHookOffer(env, AgentIdClaude, "", false)
}

func TestClaudeApplyReplacesOlderHooksAndKeepsTheRest(t *testing.T) {
	env := hookTestEnv(t)
	useTestHookBackups(t, env)
	path := filepath.Join(env.Home, ".claude", "settings.json")
	writeTestFile(t, path, olderClaudeSettings())
	offer := claudeTestOffer(t, env)
	if !offer.CanApply || offer.Action != HookActionUpdate || offer.TrustRequired {
		t.Fatalf("older Claude Code hooks: %+v", offer)
	}
	for _, want := range []AgentHookChange{
		{Kind: HookChangeAdded, Event: "SessionStart"},
		{Kind: HookChangeChanged, Event: "Notification", Field: HookFieldMatcher, Installed: "", Available: AgentStateHooks(AgentIdClaude)[3].Matcher},
	} {
		if !slices.Contains(offer.Changes, want) {
			t.Fatalf("missing %+v in %+v", want, offer.Changes)
		}
	}
	result, err := ApplyAgentHookMutation(env, flowRequest(AgentIdClaude, offer, offer.Action), false, AgentHookDetection{})
	if err != nil {
		t.Fatal(err)
	}
	if readHookFile(t, result.BackupPath) != olderClaudeSettings() {
		t.Fatal("the backup is not the file as it was")
	}
	content := readHookFile(t, path)
	assertCurrentHooks(t, AgentIdClaude, content)
	model, hooks, permissions := strings.Index(content, `"model"`), strings.Index(content, `"hooks"`), strings.Index(content, `"permissions"`)
	if model < 0 || !(model < hooks && hooks < permissions) {
		t.Fatalf("the settings' order changed: %s", content)
	}
	var parsed struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
		Permissions map[string][]string `json:"permissions"`
	}
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		t.Fatal(err)
	}
	post := parsed.Hooks["PostToolUse"]
	if len(post) != 3 || post[0].Matcher != "Bash" || post[0].Hooks[0].Command != "lint.sh" || len(post[1].Hooks) != 1 || post[1].Hooks[0].Command != "log-tool.sh" || post[1].Hooks[0].Timeout != 5 {
		t.Fatalf("the developer's PostToolUse hooks: %+v", post)
	}
	if got := parsed.Hooks["PermissionRequest"]; len(got) != 1 || got[0].Hooks[0].Command != ClaudePermissionHookCommand {
		t.Fatalf("the coffee approvals' hook is not MoltenTerm's state hook and stays: %+v", got)
	}
	if len(parsed.Permissions["allow"]) != 1 {
		t.Fatalf("permissions: %+v", parsed.Permissions)
	}
	for event, groups := range parsed.Hooks {
		count := 0
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if isMoltenHookCommand(hook.Command) {
					count++
				}
			}
		}
		if count > 1 {
			t.Fatalf("%s runs MoltenTerm's hook %d times", event, count)
		}
	}
	if again := claudeTestOffer(t, env); again.UpdateKind != "" || again.CanApply || len(again.Changes) != 0 {
		t.Fatalf("applied hooks are current: %+v", again)
	}
}

func TestJSONHookDuplicatesAreListed(t *testing.T) {
	env := hookTestEnv(t)
	path := filepath.Join(env.Home, ".claude", "settings.json")
	writeTestFile(t, path, claudeHooksSnippet)
	data := strings.Replace(claudeHooksSnippet, `"Stop": [`, `"Stop": [{ "hooks": [{ "type": "command", "command": "molten agent hook --agent claude" }] },`, 1)
	writeTestFile(t, path, data)
	offer := claudeTestOffer(t, env)
	if !slices.Contains(offer.Changes, AgentHookChange{Kind: HookChangeChanged, Event: "Stop", Field: HookFieldDuplicate}) || !offer.CanApply {
		t.Fatalf("a doubled Stop hook: %+v", offer)
	}
}

func TestJSONHookFilesThatCannotBeManaged(t *testing.T) {
	env := hookTestEnv(t)
	path := filepath.Join(env.Home, ".claude", "settings.json")
	for name, tc := range map[string]struct{ content, code string }{
		"invalid JSON":  {"{ // a comment\n", jsonHookErrorInvalid},
		"not an object": {"[1, 2]", jsonHookErrorShape},
		"hooks a list":  {`{"hooks": []}`, jsonHookErrorShape},
		"group a text":  {`{"hooks": {"Stop": ["x"]}}`, jsonHookErrorShape},
		"two hooks":     {`{"hooks": {}, "hooks": {}}`, jsonHookErrorShape},
		"trailing data": {`{} {}`, jsonHookErrorInvalid},
	} {
		writeTestFile(t, path, tc.content)
		offer := claudeTestOffer(t, env)
		if offer.Status != HookStatusInvalid || offer.ErrorCode != tc.code || offer.CanApply || offer.CanRemove || offer.Snippet == "" {
			t.Fatalf("%s: %+v", name, offer)
		}
	}
	target := filepath.Join(env.Home, "elsewhere.json")
	writeTestFile(t, target, "{}")
	os.Remove(path)
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if offer := claudeTestOffer(t, env); offer.ErrorCode != "symlink" || offer.CanApply {
		t.Fatalf("a linked settings file: %+v", offer)
	}
}

func TestJSONHookInstallCreatesTheFileAndRemoveLeavesNoHooksKey(t *testing.T) {
	env := hookTestEnv(t)
	useTestHookBackups(t, env)
	path := filepath.Join(env.Home, ".codex", "hooks.json")
	offer := MakeAgentHookOffer(env, AgentIdCodex, "", false)
	if offer.ConfigDigest != "absent" || !offer.CanApply || !offer.TrustRequired {
		t.Fatalf("no hooks.json yet: %+v", offer)
	}
	result, err := ApplyAgentHookMutation(env, flowRequest(AgentIdCodex, offer, offer.Action), false, AgentHookDetection{})
	if err != nil || result.BackupPath != "" {
		t.Fatalf("install: %+v, %v", result, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("a new hooks file is the developer's only: %v %v", info, err)
	}
	assertCurrentHooks(t, AgentIdCodex, readHookFile(t, path))
	current := MakeAgentHookOffer(env, AgentIdCodex, "", false)
	if _, err := RemoveAgentHookMutation(env, flowRequest(AgentIdCodex, current, HookActionRemove), false, AgentHookDetection{}); err != nil {
		t.Fatal(err)
	}
	if got := readHookFile(t, path); got != "{}\n" {
		t.Fatalf("after removal: %q", got)
	}
}

// A request for another action than the offer's, or with a key of another revision, writes nothing.
func TestJSONHookApprovalMustMatchTheOffer(t *testing.T) {
	env := hookTestEnv(t)
	useTestHookBackups(t, env)
	path := filepath.Join(env.Home, ".claude", "settings.json")
	writeTestFile(t, path, olderClaudeSettings())
	offer := claudeTestOffer(t, env)
	for name, req := range map[string]AgentHookMutationRequest{
		"other action": flowRequest(AgentIdClaude, offer, HookActionInstall),
		"other key":    {Agent: AgentIdClaude, Action: offer.Action, UpdateKey: "other", ExpectedDigest: offer.ConfigDigest},
		"no digest":    {Agent: AgentIdClaude, Action: offer.Action, UpdateKey: offer.UpdateKey},
	} {
		if _, err := ApplyAgentHookMutation(env, req, false, AgentHookDetection{}); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if readHookFile(t, path) != olderClaudeSettings() {
		t.Fatal("a refused approval changed the file")
	}
}
