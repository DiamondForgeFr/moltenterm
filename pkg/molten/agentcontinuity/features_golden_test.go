// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-AGC-003: a row carries its guide profile and the call of a guide, found by the agent's program. The interface
// ships the matrix TestMatrixGolden keeps in step (MatrixGoldenPath).
func TestMatrixRowsCarryGuideProfile(t *testing.T) {
	want := map[string][2]string{
		molten.AgentIdClaude:      {"claude-code", "/{name}"},
		molten.AgentIdCodex:       {"codex", "${name}"},
		molten.AgentIdGemini:      {"gemini-cli", "/{name}"},
		molten.AgentIdKimi:        {"kimi", "/skill:{name}"},
		molten.AgentIdOpenCode:    {"", ""},
		molten.AgentIdQwen:        {"qwen-code", "/{name}"},
		molten.AgentIdAntigravity: {"antigravity", "/{name}"},
		molten.AgentIdCopilot:     {"copilot", "/{name}"},
		molten.AgentIdCursor:      {"cursor", "/{name}"},
		molten.AgentIdGrok:        {"grok", "/{name}"},
		molten.AgentIdVibe:        {"vibe", "/{name}"},
	}
	for _, a := range Default().Matrix().Agents {
		if got := [2]string{a.Profile, a.GuideCall}; got != want[a.Id] {
			t.Errorf("%s: profile and guide call %v, want %v", a.Id, got, want[a.Id])
		}
	}
}

// FR-AGC-008 AC-3: Claude Code behind GLM and MiniMax has its own rows, apart from the agents: plan usage missing,
// models and effort levels Anthropic's, every other cell Claude Code's; each provider is one molten recognises.
func TestMatrixProviderRows(t *testing.T) {
	m := Default().Matrix()
	claude := Find(molten.AgentIdClaude)
	var got []string
	for _, p := range m.Providers {
		got = append(got, p.Agent+"/"+p.Provider+"/"+p.Name)
		if molten.KnownProviderName(providerHostOf(p.Provider)) != p.Provider {
			t.Errorf("%s: not a provider molten.AgentProviders names", p.Provider)
		}
		if err := checkFeatures(p.Name, p.Features, claude.Capabilities()); err != nil {
			t.Error(err)
		}
		if f := p.Features[FeatUsage]; f.Level != LevelNone || f.Reason != ReasonProvider {
			t.Errorf("%s: usage %+v", p.Name, f)
		}
		if f := p.Features[FeatEffort]; f.Level != LevelAdapted || f.Reason != ReasonModelUnverified {
			t.Errorf("%s: effort %+v", p.Name, f)
		}
		for id, f := range claude.Features() {
			if id != FeatUsage && id != FeatEffort && p.Features[id] != f {
				t.Errorf("%s: %s differs from Claude Code's", p.Name, id)
			}
		}
	}
	want := []string{"claude/GLM/Claude Code via GLM", "claude/MiniMax/Claude Code via MiniMax"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("provider rows %v, want %v", got, want)
	}
	for _, a := range m.Agents {
		if strings.Contains(a.Name, " via ") {
			t.Errorf("provider row %s listed with the agents", a.Name)
		}
	}
}

func providerHostOf(name string) string {
	for _, p := range molten.AgentProviders {
		if p.Name == name {
			return p.Domains[0]
		}
	}
	return ""
}
