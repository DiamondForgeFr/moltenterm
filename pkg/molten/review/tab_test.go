// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wcore"
)

// The agent goes on the left, the review on the right (#1165): the AI panel is split before the review block, at
// the size it had on the right.
func TestAiPaneLayoutActionPutsTheAgentFirst(t *testing.T) {
	action := aiPaneLayoutAction("ai", "review")
	if action.ActionType != wcore.LayoutActionDataType_SplitHorizontal {
		t.Errorf("action type: %q", action.ActionType)
	}
	if action.BlockId != "ai" || action.TargetBlockId != "review" {
		t.Errorf("blocks: %+v", action)
	}
	if action.Position != "before" {
		t.Errorf("the AI panel must come before the review block, got %q", action.Position)
	}
	if action.NodeSize == nil || *action.NodeSize != 6 {
		t.Errorf("node size: %v", action.NodeSize)
	}
}
