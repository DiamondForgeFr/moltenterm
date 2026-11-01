// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
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
