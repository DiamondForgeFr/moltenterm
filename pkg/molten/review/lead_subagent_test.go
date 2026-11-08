// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
)

// #1756: a sub-agent signs with its own model (or "subagent" when unknown) under its lead's first name and CLI, so the
// owner the signature names (#1779) is still the lead.
func TestSubagentSignatureStillNamesTheLead(t *testing.T) {
	t.Parallel()
	for _, sig := range []agentsign.Signature{
		{FirstName: "Arthur", Agent: "Claude Code", Model: "Sonnet 5.5", Effort: "xhigh"},
		{FirstName: "Arthur", Agent: "Claude Code", Model: "subagent"},
		{FirstName: "Arthur", Agent: "Claude Code"},
	} {
		agents := agentsign.CommitAgents("fix(#1756): x\n\n" + sig.Trailer() + "\n")
		if len(agents) != 1 {
			t.Fatalf("%+v: trailer not read back: %+v", sig, agents)
		}
		lead := (&LeadRef{FirstName: agents[0].FirstName, Agent: agents[0].Agent}).cleaned()
		if lead == nil || lead.FirstName != "Arthur" || lead.Agent != molten.AgentIdClaude {
			t.Fatalf("%+v: lead %+v", sig, lead)
		}
		block, _ := agentsign.ParseBlock(agentsign.WithAgent("Resolves #1756\n", sig))
		if len(block.Agents) != 1 || block.Agents[0].FirstName != "Arthur" || block.Agents[0].Agent != "Claude Code" {
			t.Fatalf("%+v: Made by %+v", sig, block.Agents)
		}
	}
}
