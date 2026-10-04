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
	if len(layout) != 2 {
		t.Fatalf("layout has %d panes", len(layout))
	}
	panel, term := layout[0], layout[1]
	if panel.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != onboarding.ViewType || !panel.Focused {
		t.Errorf("first pane %+v", panel)
	}
	if term.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != "term" || term.BlockDef.Meta.GetString(waveobj.MetaKey_Controller, "") != "shell" {
		t.Errorf("second pane %+v", term)
	}
	if len(panel.IndexArr) != 1 || panel.IndexArr[0] != 0 || len(term.IndexArr) != 1 || term.IndexArr[0] != 1 {
		t.Errorf("panes are not side by side: %v %v", panel.IndexArr, term.IndexArr)
	}
	// The panel gets the default node size (10) in the window's tree.
	if panel.Size != nil || term.Size == nil || *term.Size <= 10 {
		t.Errorf("the panel should be narrower than the terminal")
	}
}

func TestStartLayout(t *testing.T) {
	if startLayout(onboarding.LayoutNone) != nil {
		t.Error("no layout asked, yet one applied")
	}
	if len(startLayout(onboarding.LayoutStarter)) != len(GetStarterLayout()) {
		t.Error("skip does not get Wave's starter layout")
	}
	if len(startLayout(onboarding.LayoutFirstRun)) != 2 {
		t.Error("first start does not get the first-run layout")
	}
}
