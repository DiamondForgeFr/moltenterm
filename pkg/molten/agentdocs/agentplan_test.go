// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"
)

// agent-plan.md is what an agent reads to publish its plan for the companion (#2430).
func TestPlanGuideTeachesTheCommandsToAnyAgent(t *testing.T) {
	t.Parallel()
	data, err := fs.ReadFile(Files, "agent-plan.md")
	if err != nil {
		t.Fatalf("agent-plan.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"molten agent plan set", "molten agent plan start <n>", "molten agent plan done <n>", "molten agent plan add",
		"molten agent plan clear", "molten agent plan show [--json]", "Plan of", "TodoWrite", "update_plan",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("agent-plan.md does not mention %q", want)
		}
	}
}
