// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// FR-AGC-008: a Claude Code run behind another provider shows no Anthropic gauges and no Anthropic usage page.
func TestUsageHiddenBehindAProvider(t *testing.T) {
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"b1": {BlockId: "b1", Agent: "claude", Running: true, Settings: molten.AgentSettings{Provider: "api.z.ai"}},
		},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, t.TempDir())
	info := m.usageInfo("b1", "claude", usage.For("claude"), nil, usageRead{})
	if info.HasGauges || info.PageURL != "" || info.Provider != "api.z.ai" || info.ProviderName != "GLM" {
		t.Fatalf("usage: %+v", info)
	}
	resp, err := m.HandleStatusLine(molten.AgentStatusLineRequest{BlockId: "b1", Model: "glm-4.6", Provider: "api.z.ai"})
	if err != nil || resp.Kept {
		t.Fatalf("a provider's status line keeps no windows: %+v %v", resp, err)
	}
}

func TestEverySupportedAgentHasAUsagePage(t *testing.T) {
	for _, agent := range SupportedAgents {
		if usage.For(agent) == nil {
			t.Errorf("%s has a companion but no usage adapter", agent)
		}
	}
}

func TestCompanionViewCarriesTheUsagePage(t *testing.T) {
	start := time.Now().Add(-time.Second).UnixMilli()
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"b1": {BlockId: "b1", Agent: "claude", Started: start, Running: true},
			"b2": {BlockId: "b2", Agent: "gemini", Started: start, Running: true},
		},
		cwds:  map[string]string{"b1": t.TempDir(), "b2": t.TempDir()},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, t.TempDir())
	defer m.Close("b1", "v")
	defer m.Close("b2", "v")

	m.Open("b1", "v")
	v := waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusSearching })
	if v.Usage == nil || v.Usage.PageURL != usage.ClaudeUsagePageURL || v.Usage.PageName != "Claude usage" {
		t.Errorf("Claude Code's view: usage %+v", v.Usage)
	}
	m.Open("b2", "v")
	v = waitView(t, env, "b2", func(v CompanionView) bool { return v.Status == StatusUnsupportedAgent })
	if v.Usage != nil {
		t.Errorf("an agent without a usage adapter has no usage page: %+v", v.Usage)
	}

	info, err := m.Usage("b1", false)
	if err != nil || info.PageURL != usage.ClaudeUsagePageURL || info.Gauges != usage.GaugesOff || info.Snapshot != nil {
		t.Errorf("usage of b1: %+v %v", info, err)
	}
	if _, err := m.Usage("b2", false); err == nil {
		t.Error("no usage page for an agent without an adapter")
	}
	if _, err := m.Usage("nothing", false); err == nil {
		t.Error("no usage page without an agent")
	}

	// The agent states alone (no companion open) are enough.
	env.lock.Lock()
	env.runs["b3"] = molten.AgentRunInfo{BlockId: "b3", Agent: "codex", Started: start}
	env.lock.Unlock()
	if info, err := m.Usage("b3", false); err != nil || info.PageURL != usage.CodexUsagePageURL || info.Agent != "codex" {
		t.Errorf("usage of b3: %+v %v", info, err)
	}
}
