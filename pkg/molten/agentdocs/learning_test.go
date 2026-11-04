// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"
)

// learning.md is what the instructions of the molten browser server point to for a guided workflow (FR-LRN-002).
func TestLearningGuideTeachesTheCommandsAndTheRules(t *testing.T) {
	data, err := fs.ReadFile(Files, "learning.md")
	if err != nil {
		t.Fatalf("learning.md is not embedded: %v", err)
	}
	text := string(data)
	wants := []string{
		"molten learn defaults", "molten learn record", "molten learn list", "molten learn forget",
		"--answer", "--preference", "--correction", "--proposed", "--skip", "--done", "--run",
		"never remove a step", "Never record", "a secret", "on this computer", "Exit codes: 2",
		"`pipeline-setup`", "`morph-design`",
	}
	for _, want := range wants {
		if !strings.Contains(text, want) {
			t.Errorf("learning.md does not mention %q", want)
		}
	}
}
