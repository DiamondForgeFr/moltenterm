// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func (h *agentHarness) send(req molten.AgentStateRequest) {
	if _, _, err := h.states.report(req); err != nil {
		panic(err)
	}
}

// FR-AGC-008: a Claude Code run behind another provider is marked with it from its start report.
func TestAgentProviderFollowsTheRun(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateIdle, Agent: "claude", Start: true, Provider: "api.z.ai"})
	info := h.info("b1")
	if info.Provider != "api.z.ai" || info.ProviderName != "GLM" {
		t.Fatalf("the start report names the provider: %+v", info)
	}
	if run, _ := h.states.runOf("b1"); run.Settings.Provider != "api.z.ai" {
		t.Fatalf("the run carries it: %+v", run)
	}
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude"})
	if info := h.info("b1"); info.Provider != "api.z.ai" {
		t.Fatalf("a report without a provider changes nothing: %+v", info)
	}
	h.states.setSettings("b1", "claude", molten.AgentSettings{Model: "glm-4.6", Provider: "api.z.ai"})
	if info := h.info("b1"); info.Provider != "api.z.ai" || info.Model != "glm-4.6" {
		t.Fatalf("the status line keeps it: %+v", info)
	}
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateIdle, Agent: "claude", Start: true})
	if info := h.info("b1"); info.Provider != "" || info.ProviderName != "" {
		t.Fatalf("a start without a provider talks to Anthropic: %+v", info)
	}
}

func TestAgentProviderUnknownHostAndOtherAgents(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", Provider: "llm.gateway.internal"})
	if info := h.info("b1"); info.Provider != "llm.gateway.internal" || info.ProviderName != "llm.gateway.internal" {
		t.Fatalf("an unknown host is named by itself in the windows: %+v", info)
	}
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", Provider: "user:secret@evil/x"})
	if info := h.info("b1"); info.Provider != "llm.gateway.internal" {
		t.Fatalf("a value that is not a host is ignored: %+v", info)
	}
	h.out("b2", cmdMark("codex"))
	h.send(molten.AgentStateRequest{BlockId: "b2", State: molten.AgentStateIdle, Agent: "codex", Start: true, Provider: "api.z.ai"})
	if info := h.info("b2"); info.Provider != "" {
		t.Fatalf("only Claude Code is behind ANTHROPIC_BASE_URL: %+v", info)
	}
}
