// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

func TestMoltenWhoamiClaudeCode(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Valentin", Agent: "claude", AgentName: "Claude Code", Model: "claude-opus-5-5", ModelName: "Opus 5.5", Effort: "medium", You: true}
	w, err := moltenWhoamiOf(handoffwire.ListResult{You: &you, Agents: []handoffwire.AgentEntry{you}})
	if err != nil {
		t.Fatal(err)
	}
	if w.Line != "Valentin · Claude Code · Opus 5.5 · medium" || w.Trailer != "Molten-Agent: Valentin (Claude Code, Opus 5.5, medium)" || w.ModelId != "claude-opus-5-5" {
		t.Fatalf("whoami: %+v", w)
	}
	text := formatMoltenWhoami(w)
	if !strings.HasPrefix(text, "Valentin · Claude Code · Opus 5.5 · medium\n") || !strings.Contains(text, "model:   Opus 5.5 (claude-opus-5-5)\n") {
		t.Fatalf("text:\n%s", text)
	}
}

func TestMoltenWhoamiCodexWithoutDisplayName(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Jérôme", Agent: "codex", AgentName: "Codex", Model: "gpt-5.5-codex", Effort: "high", You: true}
	w, err := moltenWhoamiOf(handoffwire.ListResult{You: &you})
	if err != nil {
		t.Fatal(err)
	}
	if w.Line != "Jérôme · Codex · gpt-5.5-codex · high" || w.ModelId != "" {
		t.Fatalf("whoami: %+v", w)
	}
}

func TestMoltenWhoamiUnknownModelAndNoAgent(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Camille", Agent: "claude", AgentName: "Claude Code", You: true}
	w, err := moltenWhoamiOf(handoffwire.ListResult{You: &you})
	if err != nil || w.Trailer != "Molten-Agent: Camille (Claude Code)" {
		t.Fatalf("unknown model left out: %+v %v", w, err)
	}
	if !strings.Contains(formatMoltenWhoami(w), "model:   -\n") {
		t.Fatalf("text: %s", formatMoltenWhoami(w))
	}
	if _, err := moltenWhoamiOf(handoffwire.ListResult{}); err == nil {
		t.Fatal("a terminal without an agent has no signature")
	}
}
