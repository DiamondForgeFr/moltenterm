// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func (h *agentHarness) info(block string) molten.AgentStateInfo {
	for _, info := range h.states.snapshot() {
		if info.BlockId == block {
			return info
		}
	}
	return molten.AgentStateInfo{}
}

// The model and effort an agent reports stay with its run and are published with its state (#549).
func TestAgentSettingsFollowTheRun(t *testing.T) {
	h := makeAgentHarness()
	opus := molten.AgentSettings{Model: "claude-opus-5-5", ModelName: "Opus", Effort: "high"}
	if h.states.setSettings("b1", "claude", opus) {
		t.Fatalf("a block without an agent takes no settings")
	}
	h.out("b1", cmdMark("claude"))
	if h.states.setSettings("b1", "codex", opus) {
		t.Fatalf("another agent's report is not this run's")
	}
	before := h.info("b1").Version
	if !h.states.setSettings("b1", "claude", opus) {
		t.Fatalf("the running agent's settings are kept")
	}
	info := h.info("b1")
	if info.Model != "claude-opus-5-5" || info.ModelName != "Opus" || info.Effort != "high" || info.Version <= before {
		t.Fatalf("published: %+v", info)
	}
	if h.states.setSettings("b1", "claude", opus) {
		t.Fatalf("the same settings mark nothing")
	}
	if run, _ := h.states.runOf("b1"); run.Settings != opus {
		t.Fatalf("the run carries them: %+v", run)
	}
	if runs := h.states.allRuns(); len(runs) != 1 || runs[0].Settings != opus {
		t.Fatalf("every run carries them too, for molten agent whoami (#847): %+v", runs)
	}
	h.states.clearEffort("b1", "claude")
	if info := h.info("b1"); info.Effort != "" || info.Model != "claude-opus-5-5" {
		t.Fatalf("a cleared effort keeps the model: %+v", info)
	}
	h.states.setSettings("b1", "claude", molten.AgentSettings{Model: "claude-haiku-4-5", ModelName: "Haiku"})
	if info := h.info("b1"); info.Effort != "" || info.ModelName != "Haiku" {
		t.Fatalf("a model without effort reports none: %+v", info)
	}
	h.out("b1", doneMark(0)+promptMark)
	h.out("b1", cmdMark("claude"))
	if info := h.info("b1"); info.Model != "" || info.Effort != "" {
		t.Fatalf("a new run starts without the last run's settings: %+v", info)
	}
}

// #2076: a turn Codex refused for its model is published with the state, for the header's way out.
func TestAgentSettingsPublishAnUnavailableModel(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("codex"))
	h.states.setSettings("b1", "codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "high"})
	if h.info("b1").ModelUnavailable {
		t.Fatalf("a model that runs is available")
	}
	if !h.states.setSettings("b1", "codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "high", ModelUnavailable: true}) {
		t.Fatalf("the refusal is a change")
	}
	if info := h.info("b1"); !info.ModelUnavailable || info.Model != "gpt-6-astra" {
		t.Fatalf("published: %+v", info)
	}
	h.states.setSettings("b1", "codex", molten.AgentSettings{Model: "gpt-6-luna", Effort: "medium"})
	if h.info("b1").ModelUnavailable {
		t.Fatalf("another model clears it")
	}
}

func TestAgentSettingsResetWhenAHookNamesAnotherAgent(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.states.setSettings("b1", "claude", molten.AgentSettings{Model: "claude-opus-5-5", Effort: "high"})
	if err := h.report("b1", molten.AgentStateWorking, "codex"); err != nil {
		t.Fatal(err)
	}
	if info := h.info("b1"); info.Model != "" || info.Effort != "" {
		t.Fatalf("Codex's run does not show Claude Code's model: %+v", info)
	}
}
