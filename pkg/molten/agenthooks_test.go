// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

const moltenClaudeSettings = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent claude || true"}]}]}}`

func writeTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func hookTestEnv(t *testing.T) AgentEnv {
	managed := filepath.Join(t.TempDir(), "managed-settings.json")
	previous := claudeManagedSettings
	claudeManagedSettings = func() string { return managed }
	t.Cleanup(func() { claudeManagedSettings = previous })
	return testAgentEnv(t)
}

func TestHookSnippetsAreTheDocumentedOnes(t *testing.T) {
	doc, err := agentdocs.Files.ReadFile(agentStatesDocFile)
	if err != nil {
		t.Fatal(err)
	}
	for agent, setup := range agentHookSetups {
		if !strings.Contains(string(doc), setup.snippet) {
			t.Fatalf("the %s snippet differs from %s", agent, agentStatesDocFile)
		}
	}
}

func TestClaudeHooksDetection(t *testing.T) {
	env := hookTestEnv(t)
	repo := filepath.Join(env.Home, "work", "repo")
	sub := filepath.Join(repo, "pkg", "deep")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	if claudeHooksConfigured(env, sub) {
		t.Fatalf("no settings at all: not set up")
	}

	other := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"afplay done.wav"}]}]},"model":"opus"}`
	writeTestFile(t, filepath.Join(env.Home, ".claude", "settings.json"), other)
	if claudeHooksConfigured(env, sub) {
		t.Fatalf("hooks that do not run molten agent state: not set up")
	}

	above := filepath.Join(env.Home, "work", ".claude", "settings.json")
	writeTestFile(t, above, moltenClaudeSettings)
	if claudeHooksConfigured(env, sub) {
		t.Fatalf("settings above the repository's root are not the project's")
	}
	os.Remove(above)

	cases := map[string]string{
		"user":          filepath.Join(env.Home, ".claude", "settings.json"),
		"project":       filepath.Join(repo, ".claude", "settings.json"),
		"local":         filepath.Join(repo, ".claude", "settings.local.json"),
		"subfolder":     filepath.Join(sub, ".claude", "settings.local.json"),
		"managed":       claudeManagedSettings(),
		"invalid JSON":  filepath.Join(repo, ".claude", "settings.local.json"),
		"user override": filepath.Join(env.Home, "alt", "settings.json"),
	}
	for name, path := range cases {
		content := moltenClaudeSettings
		if name == "invalid JSON" {
			content = "{ // molten agent state done\n"
		}
		caseEnv := env
		if name == "user override" {
			caseEnv.Getenv = func(key string) string {
				if key == "CLAUDE_CONFIG_DIR" {
					return filepath.Join(env.Home, "alt")
				}
				return ""
			}
		}
		writeTestFile(t, path, content)
		if !claudeHooksConfigured(caseEnv, sub) {
			t.Fatalf("%s settings (%s) hold the hooks", name, path)
		}
		if name == "user" {
			writeTestFile(t, path, other)
		} else {
			os.Remove(path)
		}
	}
}

func TestCodexHooksDetection(t *testing.T) {
	env := hookTestEnv(t)
	config := filepath.Join(env.Home, ".codex", "config.toml")
	writeTestFile(t, config, "model = \"o4\"\n# "+codexNotifySnippet+"\n")
	if codexHooksConfigured(env, "") {
		t.Fatalf("a commented-out notify is not set up")
	}
	writeTestFile(t, config, "model = \"o4\"\n"+codexNotifySnippet+"\n")
	if !codexHooksConfigured(env, "") {
		t.Fatalf("the documented notify is set up")
	}
	alt := filepath.Join(env.Home, "codexhome")
	writeTestFile(t, filepath.Join(alt, "config.toml"), codexNotifySnippet)
	os.Remove(config)
	env.Getenv = func(key string) string {
		if key == "CODEX_HOME" {
			return alt
		}
		return ""
	}
	if !codexHooksConfigured(env, "") {
		t.Fatalf("CODEX_HOME's config is read")
	}
}

func TestHookOfferRules(t *testing.T) {
	env := hookTestEnv(t)
	cwd := filepath.Join(env.Home, "proj")

	offer := MakeAgentHookOffer(env, "claude", cwd, false)
	if !offer.Show || offer.File != "~/.claude/settings.json" || offer.Language != "json" || offer.Snippet != claudeHooksSnippet || offer.AgentName != "Claude Code" {
		t.Fatalf("a Claude Code without hooks gets the offer: %+v", offer)
	}
	if offer := MakeAgentHookOffer(env, "codex", cwd, false); !offer.Show || offer.File != "~/.codex/config.toml" || offer.Language != "toml" {
		t.Fatalf("a Codex without notify gets the offer: %+v", offer)
	}
	for _, agent := range []string{"gemini", "opencode", "my-agent"} {
		if offer := MakeAgentHookOffer(env, agent, cwd, false); offer.Show || offer.Reason != HookOfferUnsupported {
			t.Fatalf("%s has no documented snippet: %+v", agent, offer)
		}
	}
	if offer := MakeAgentHookOffer(env, "claude", cwd, true); offer.Show || offer.Reason != HookOfferHooked {
		t.Fatalf("hooks that reported: no offer: %+v", offer)
	}

	writeTestFile(t, filepath.Join(cwd, ".claude", "settings.json"), moltenClaudeSettings)
	if offer := MakeAgentHookOffer(env, "claude", cwd, false); offer.Show || offer.Reason != HookOfferConfigured {
		t.Fatalf("set up in the project: no offer: %+v", offer)
	}
	if offer := MakeAgentHookOffer(env, "claude", filepath.Join(env.Home, "elsewhere"), false); !offer.Show {
		t.Fatalf("another project without hooks still gets it: %+v", offer)
	}

	if err := SetAgentDeclined(env.DataDir, "claude-code", true); err != nil {
		t.Fatal(err)
	}
	if offer := MakeAgentHookOffer(env, "claude", "", false); offer.Show || offer.Reason != HookOfferRemoved {
		t.Fatalf("molten agent remove claude-code refuses the offer too: %+v", offer)
	}
	if offer := MakeAgentHookOffer(env, "codex", "", false); !offer.Show {
		t.Fatalf("removing Claude Code's guides leaves Codex alone: %+v", offer)
	}

	if err := DeclineAgentHooksOffer(env.DataDir, "codex"); err != nil {
		t.Fatal(err)
	}
	if offer := MakeAgentHookOffer(env, "codex", "", false); offer.Show || offer.Reason != HookOfferDeclined {
		t.Fatalf("a dismissed offer does not come back: %+v", offer)
	}
	if err := MarkAgentHooksSeen(env.DataDir, "claude"); err != nil {
		t.Fatal(err)
	}
	if offer := MakeAgentHookOffer(env, "claude", "", false); offer.Show || offer.Reason != HookOfferSeen {
		t.Fatalf("hooks seen in an earlier run: no offer: %+v", offer)
	}
}

func TestHookOfferMemoryKeepsTheGuidesRecord(t *testing.T) {
	env := testAgentEnv(t)
	if err := SetAgentDeclined(env.DataDir, "gemini-cli", true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := DeclineAgentHooksOffer(env.DataDir, "claude"); err != nil {
			t.Fatal(err)
		}
		if err := MarkAgentHooksSeen(env.DataDir, "codex"); err != nil {
			t.Fatal(err)
		}
	}
	state, err := readAgentGuidesState(env.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(state.Declined, ",") != "gemini-cli" || strings.Join(state.HooksDeclined, ",") != "claude" || strings.Join(state.HooksSeen, ",") != "codex" {
		t.Fatalf("record %+v", state)
	}
	if !IsAgentDeclined(env.DataDir, "gemini-cli") || IsAgentHooksOfferDeclined(env.DataDir, "codex") || !AgentHooksSeen(env.DataDir, "codex") {
		t.Fatalf("lookups disagree with the record %+v", state)
	}

	writeTestFile(t, agentGuidesFile(env.DataDir), "{broken")
	if err := DeclineAgentHooksOffer(env.DataDir, "codex"); err == nil {
		t.Fatalf("an unreadable record is not overwritten")
	}
	if IsAgentHooksOfferDeclined(env.DataDir, "claude") {
		t.Fatalf("an unreadable record remembers nothing")
	}
}

func TestAgentStatesDocPath(t *testing.T) {
	dataDir := t.TempDir()
	path, err := AgentStatesDocPath(dataDir, "9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), claudeHooksSnippet) {
		t.Fatalf("doc at %s: %v", path, err)
	}
	if filepath.Dir(path) != DocsDir(dataDir, "9.9.9") {
		t.Fatalf("written where molten docs writes: %s", path)
	}
}
