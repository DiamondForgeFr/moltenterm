// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The matrix the interface's tests read (FR-AGC-003): they prove the interface behaves as before with wavesrv's real
// matrix, so the copy they read must be this one.
const matrixGolden = "../../../frontend/moltenterm-shell/agent-info/testdata/agent-features.json"

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
	if string(have) != string(data) {
		t.Errorf("the matrix the interface's tests read changed (MOLTEN_UPDATE_GOLDEN=1 rewrites it)")
	}
}

// FR-AGC-003: a row carries its guide profile and the call of a guide, found by the agent's program.
func TestMatrixRowsCarryGuideProfile(t *testing.T) {
	want := map[string][2]string{
		molten.AgentIdClaude:   {"claude-code", "/{name}"},
		molten.AgentIdCodex:    {"codex", "${name}"},
		molten.AgentIdGemini:   {"gemini-cli", "/{name}"},
		molten.AgentIdKimi:     {"kimi", "/skill:{name}"},
		molten.AgentIdOpenCode: {"", ""},
	}
	for _, a := range Default().Matrix().Agents {
		if got := [2]string{a.Profile, a.GuideCall}; got != want[a.Id] {
			t.Errorf("%s: profile and guide call %v, want %v", a.Id, got, want[a.Id])
		}
	}
}
