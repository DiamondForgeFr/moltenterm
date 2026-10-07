// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
)

func TestFormatMoltenAgentListings(t *testing.T) {
	claude := agentcontinuity.Find("claude")
	briefing := claude.Briefing()
	listings := []agentcontinuity.AgentListing{
		{Id: "claude", Name: "Claude Code", Supported: true, Detection: agentcontinuity.Detection{Installed: true, Path: "/h/.local/bin/claude", Version: "2.1.292"},
			Briefing: &briefing, Capabilities: claude.Capabilities(), Models: claude.Models(agentcontinuity.ModelEnv{})},
		{Id: "codex", Name: "Codex", Supported: true, Detection: agentcontinuity.Detection{Path: "/h/bin/codex", Reason: "its --version did not answer within 3s"},
			Capabilities: agentcontinuity.Find("codex").Capabilities()},
		{Id: "gemini", Name: "Gemini CLI", Unsupported: "no adapter yet (FR-CONT-013, #333)", Detection: agentcontinuity.Detection{Reason: "not found on PATH"}},
	}
	out := formatMoltenAgentListings(listings)
	for _, want := range []string{
		"AGENT", "BRIEFING", "systemappend D", "2.1.292", "/h/.local/bin/claude", "D*",
		"Codex: its --version did not answer within 3s", "Gemini CLI: not found on PATH; no adapter yet", "D documented, U undocumented",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("agent list misses %q:\n%s", want, out)
		}
	}
	lines := strings.Split(out, "\n")
	if !strings.HasPrefix(lines[2], "codex") || !strings.Contains(lines[2], " no ") || !strings.Contains(lines[2], "U*") {
		t.Errorf("codex row %q", lines[2])
	}
	data, err := json.Marshal(MoltenAgentList{Agents: listings})
	if err != nil || !strings.Contains(string(data), `"installed":true`) || !strings.Contains(string(data), `"channel":"systemappend"`) || !strings.Contains(string(data), `"guides":null`) {
		t.Errorf("json %s %v", data, err)
	}
}
