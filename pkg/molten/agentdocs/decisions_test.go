// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"
)

// agent-decisions.md is what a lead reads to settle the stop of an agent whose question it decided (#1876).
func TestDecisionsGuideTeachesTheSettleCommandToAnyAgent(t *testing.T) {
	data, err := fs.ReadFile(Files, "agent-decisions.md")
	if err != nil {
		t.Fatalf("agent-decisions.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"molten agent decision settle <ticket|agent>", "--note", "--json", "settled by", "send_to_agent",
		"found ready on GitHub settles nothing", "own terminal", "any agent CLI",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("agent-decisions.md does not mention %q", want)
		}
	}
}
