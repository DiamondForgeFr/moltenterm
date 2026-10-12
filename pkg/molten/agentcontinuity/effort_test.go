// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestClaudeEffortLevels(t *testing.T) {
	if got := ClaudeEffortLevels("claude-opus-5-5"); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("Opus 5.5: %v", got)
	}
	if got := ClaudeEffortLevels("claude-sonnet-4-6"); slices.Contains(got, "xhigh") || !slices.Contains(got, "max") {
		t.Fatalf("Sonnet 4.6 has no xhigh: %v", got)
	}
	if got := ClaudeEffortLevels(""); len(got) != 5 {
		t.Fatalf("a model not reported yet: %v", got)
	}
}

func codexHomeEnv(t *testing.T, files map[string]string) ModelEnv {
	home := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(home, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return molten.AgentEnv{Home: t.TempDir(), Getenv: func(k string) string {
		if k == "CODEX_HOME" {
			return home
		}
		return ""
	}}
}

func TestCodexEffortLevelsFollowTheShortcuts(t *testing.T) {
	env := codexHomeEnv(t, map[string]string{
		"models_cache.json": `{"models":[
			{"slug":"gpt-a","supported_reasoning_levels":[{"effort":"low"},{"effort":"max"},{"effort":"medium"},{"effort":"ultra"},{"effort":"high"}]},
			{"slug":"gpt-b","supported_reasoning_levels":[]}
		]}`,
	})
	if got := CodexEffortLevels(env, "gpt-a"); !slices.Equal(got, []string{"low", "medium", "high", "max"}) {
		t.Fatalf("plain efforts first, then max, never ultra: %v", got)
	}
	if got := CodexEffortLevels(env, "gpt-b"); len(got) != 0 {
		t.Fatalf("no levels: %v", got)
	}
	if got := CodexEffortLevels(env, "gpt-unknown"); got != nil {
		t.Fatalf("a model not in the cache: %v", got)
	}
	if CodexEffortKeysRemapped(env) {
		t.Fatal("no config: the default keys")
	}
	remapped := codexHomeEnv(t, map[string]string{"config.toml": "[tui.keymap.chat]\nincrease_reasoning_effort = \"ctrl-up\"\n"})
	if !EffortKeysRemapped(remapped, molten.AgentIdCodex) || EffortKeysRemapped(remapped, molten.AgentIdClaude) {
		t.Fatal("moved keys are seen for Codex only")
	}
}
