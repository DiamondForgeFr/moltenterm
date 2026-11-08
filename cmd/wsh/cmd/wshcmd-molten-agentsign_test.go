// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
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

// FR-AGC-008: a run behind another provider names it in its signature; an unknown host stays off the PR.
func TestMoltenWhoamiBehindAProvider(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Valentin", Agent: "claude", AgentName: "Claude Code", Model: "glm-4.6", Effort: "high", Provider: "api.z.ai", ProviderName: "GLM", You: true}
	w, err := moltenWhoamiOf(handoffwire.ListResult{You: &you})
	if err != nil || w.Trailer != "Molten-Agent: Valentin (Claude Code via GLM, glm-4.6, high)" {
		t.Fatalf("whoami: %+v %v", w, err)
	}
	you.Provider, you.ProviderName = "llm.corp.internal", ""
	w, _ = moltenWhoamiOf(handoffwire.ListResult{You: &you})
	if w.Line != "Valentin · Claude Code via another provider · glm-4.6 · high" {
		t.Fatalf("whoami: %+v", w)
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

// #1756: a sub-agent's call signs with its model and effort under the lead's first name and CLI.
func TestMoltenWhoamiSubagentWithKnownModel(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Arthur", Agent: "claude", AgentName: "Claude Code", Model: "claude-opus-5-5", ModelName: "Opus 5.5", Effort: "medium", You: true}
	caller := &handoffwire.CallerEntry{Subagent: true, Kind: "sf-build", Model: "claude-sonnet-5-5", Effort: "xhigh"}
	w, err := moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: caller})
	if err != nil {
		t.Fatal(err)
	}
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, Sonnet 5.5, xhigh)" || w.Line != "Arthur · Claude Code · Sonnet 5.5 · xhigh" {
		t.Fatalf("whoami: %+v", w)
	}
	if !w.Subagent || w.SubagentKind != "sf-build" || w.ModelId != "claude-sonnet-5-5" {
		t.Fatalf("whoami: %+v", w)
	}
	text := formatMoltenWhoami(w)
	if !strings.Contains(text, "model:   Sonnet 5.5 (claude-sonnet-5-5)\n") || !strings.Contains(text, "caller:  a sub-agent (sf-build) of Arthur's session\n") {
		t.Fatalf("text:\n%s", text)
	}
	body := agentsign.WithAgent("Resolves #1756\n", w.Signature)
	if !strings.Contains(body, "Made by Arthur · Claude Code · Sonnet 5.5 · xhigh\n") {
		t.Fatalf("sign-pr body:\n%s", body)
	}
}

func TestMoltenWhoamiSubagentWithoutModel(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Arthur", Agent: "claude", AgentName: "Claude Code", Model: "claude-opus-5-5", ModelName: "Opus 5.5", Effort: "medium", You: true}
	w, _ := moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: &handoffwire.CallerEntry{Subagent: true}})
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, subagent)" || w.ModelId != "" || w.Effort != "" {
		t.Fatalf("an unknown sub-agent model is never the lead's: %+v", w)
	}
	if !strings.Contains(formatMoltenWhoami(w), "caller:  a sub-agent of Arthur's session\n") {
		t.Fatalf("text:\n%s", formatMoltenWhoami(w))
	}
	if body := agentsign.WithAgent("", w.Signature); !strings.Contains(body, "Made by Arthur · Claude Code · subagent\n") {
		t.Fatalf("sign-pr body:\n%s", body)
	}
	w, _ = moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: &handoffwire.CallerEntry{Subagent: true, Model: "claude-opus-5-5[1m]", Effort: "high"}})
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, Opus 5.5, high)" || w.ModelId != "claude-opus-5-5[1m]" {
		t.Fatalf("the lead's model, the sub-agent's effort: %+v", w)
	}
	w, _ = moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: &handoffwire.CallerEntry{Subagent: true, Model: "gpt-5.5-codex"}})
	if w.Model != "gpt-5.5-codex" || w.ModelId != "" {
		t.Fatalf("an id with no known name stays the id: %+v", w)
	}
}

// Sub-agents in the session's folder: the call may be theirs, so only what they say alike with the lead is signed.
func TestMoltenWhoamiSharedFolder(t *testing.T) {
	you := handoffwire.AgentEntry{FirstName: "Arthur", Agent: "claude", AgentName: "Claude Code", Model: "claude-opus-5-5", ModelName: "Opus 5.5", Effort: "medium", You: true}
	w, _ := moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: &handoffwire.CallerEntry{Shared: true, Model: "claude-haiku-5-5", Effort: "medium"}})
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, medium)" || !w.Shared || w.Subagent || w.ModelId != "" {
		t.Fatalf("no model asserted: %+v", w)
	}
	if !strings.Contains(formatMoltenWhoami(w), "caller:  Arthur's session or one of its sub-agents in the same folder\n") {
		t.Fatalf("text:\n%s", formatMoltenWhoami(w))
	}
	w, _ = moltenWhoamiOf(handoffwire.ListResult{You: &you, Caller: &handoffwire.CallerEntry{Shared: true, Model: "claude-opus-5-5", Effort: "high"}})
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, Opus 5.5)" {
		t.Fatalf("the model they share is kept, the effort they do not is left out: %+v", w)
	}
	w, _ = moltenWhoamiOf(handoffwire.ListResult{You: &you})
	if w.Trailer != "Molten-Agent: Arthur (Claude Code, Opus 5.5, medium)" || w.Subagent || w.Shared {
		t.Fatalf("the lead's own call: %+v", w)
	}
}

func TestMoltenModelName(t *testing.T) {
	for id, want := range map[string]string{
		"claude-sonnet-5-5":          "Sonnet 5.5",
		"claude-haiku-5-5-20261001":  "Haiku 5.5",
		"claude-opus-5":              "Opus 5",
		"Claude-Fable-5-5[1m]":       "Fable 5.5",
		"claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022",
		"gpt-5.5-codex":              "gpt-5.5-codex",
	} {
		if got := moltenModelName(id, handoffwire.AgentEntry{}, false); got != want {
			t.Errorf("%s: %q, want %q", id, got, want)
		}
	}
}
