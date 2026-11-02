// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentdocs

import (
	"strings"
	"testing"
)

// #1152: the pipeline setup's writing guide carries the epic's decisions; the setup tab's agent gets it as its brief.
func TestPipelineWritingGuideSaysWhatTheMockupsDecided(t *testing.T) {
	guide, err := Files.ReadFile(PipelineWritingGuideFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"marquer la version", "étiquette de version", "demande de validation", "five sentences",
		"Never name an operating system", "What it never asks", "I don't know, choose for me",
		"molten pipeline setup propose", "pipeline-setup-agent.md"} {
		if !strings.Contains(string(guide), want) {
			t.Errorf("the guide lacks %q", want)
		}
	}
}
