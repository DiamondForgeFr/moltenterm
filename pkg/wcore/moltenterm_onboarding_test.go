// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/onboarding"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestFirstRunLayout(t *testing.T) {
	layout := FirstRunLayout()
	// The welcome is full frame (FR-SHELL-110): the panel alone, no terminal beside it.
	if len(layout) != 1 {
		t.Fatalf("layout has %d panes", len(layout))
	}
	panel := layout[0]
	if panel.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != onboarding.ViewType || !panel.Focused {
		t.Errorf("first pane %+v", panel)
	}
	if len(panel.IndexArr) != 1 || panel.IndexArr[0] != 0 {
		t.Errorf("the panel is not the view's only pane: %v", panel.IndexArr)
	}
}

func TestStartLayout(t *testing.T) {
	if startLayout(onboarding.LayoutNone) != nil {
		t.Error("no layout asked, yet one applied")
	}
	if len(startLayout(onboarding.LayoutStarter)) != len(GetStarterLayout()) {
		t.Error("skip does not get Wave's starter layout")
	}
	if len(startLayout(onboarding.LayoutFirstRun)) != 1 {
		t.Error("first start does not get the first-run layout")
	}
}
