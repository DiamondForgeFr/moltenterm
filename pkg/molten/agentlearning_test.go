// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"io/fs"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

// Every workflow that learns is named in the agent guide, so an agent can tell which names it may use.
func TestLearningGuideNamesEveryWorkflow(t *testing.T) {
	data, err := fs.ReadFile(agentdocs.Files, "learning.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, workflow := range LearningWorkflows {
		if !strings.Contains(string(data), "`"+workflow+"`") {
			t.Errorf("learning.md does not name the workflow %q", workflow)
		}
	}
}

func TestLearningItemsAreFoldedAndPrefilledByTheirKind(t *testing.T) {
	for _, kind := range LearningValueKinds {
		if !LearningHoldsValue(kind) {
			t.Errorf("%s holds a value", kind)
		}
	}
	for _, kind := range []string{LearningKindSkip, LearningKindDone, "other", ""} {
		if LearningHoldsValue(kind) {
			t.Errorf("%q holds no value", kind)
		}
	}
	if LearningItemId(LearningKindCorrection, "merge") != "correction:merge" {
		t.Fatal("an item id is its kind and its key")
	}
}
