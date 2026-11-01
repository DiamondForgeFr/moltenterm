// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The matrix shipped in the interface's build (FR-AGC-003): the interface starts from it before the route answers, and
// its tests prove it behaves as before with it, so it must be this one.
const matrixGolden = "../../../frontend/moltenterm-shell/agent-info/agent-features.json"

func TestMatrixGoldenForInterface(t *testing.T) {
	data, err := json.MarshalIndent(Default().Matrix(), "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if os.Getenv("MOLTEN_UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(matrixGolden, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(matrixGolden)
	if err != nil {
		t.Fatal(err)
	}
	// Compared as data: a formatter may lay the file out its own way.
	var haveData, wantData any
	if err := json.Unmarshal(have, &haveData); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &wantData); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(haveData, wantData) {
		t.Errorf("the matrix the interface ships changed (MOLTEN_UPDATE_GOLDEN=1 rewrites it)")
	}
}

// FR-AGC-003: a row carries its guide profile and the call of a guide, found by the agent's program.
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
