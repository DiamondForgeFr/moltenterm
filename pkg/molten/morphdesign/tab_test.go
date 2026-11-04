// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Agent left, graphics right (DS-REV-012): the terminal is the first column, the panel the second and focused.
func TestTabLayoutPutsTheTerminalOnTheLeftAndThePanelOnTheRight(t *testing.T) {
	layout := tabLayout(molten.MorphDesignTabRequest{WorkspaceId: "ws", Mod: "branch-box", Name: " Branch box ", Dir: "/work/app/"})
	if len(layout) != 2 {
		t.Fatalf("got %d panels, want a terminal and the design panel", len(layout))
	}
	term, panel := layout[0], layout[1]
	if term.IndexArr[0] != 0 || panel.IndexArr[0] != 1 {
		t.Fatalf("the terminal is the first column and the panel the second: %v %v", term.IndexArr, panel.IndexArr)
	}
	if term.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != "term" || term.BlockDef.Meta.GetString(waveobj.MetaKey_Controller, "") != "shell" ||
		term.BlockDef.Meta.GetString(waveobj.MetaKey_CmdCwd, "") != "/work/app" || term.BlockDef.Meta.GetString(TermMetaKey, "") != "branch-box" {
		t.Errorf("terminal: %+v", term.BlockDef.Meta)
	}
	if term.Focused || !panel.Focused {
		t.Errorf("the panel has the focus: terminal %v panel %v", term.Focused, panel.Focused)
	}
	if *term.Size >= *panel.Size {
		t.Errorf("the panel is the wider column: %d against %d", *term.Size, *panel.Size)
	}
	if panel.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != View {
		t.Errorf("panel view: %+v", panel.BlockDef.Meta)
	}
	target, ok := panel.BlockDef.Meta[PanelMetaKey].(PanelTarget)
	if !ok || target.Mod != "branch-box" || target.Name != "Branch box" || target.Dir != "/work/app" {
		t.Errorf("panel target: %+v", panel.BlockDef.Meta[PanelMetaKey])
	}
}

func TestTabNameIsTheWindowsOrDesignAndTheModsName(t *testing.T) {
	cases := []struct {
		req  molten.MorphDesignTabRequest
		want string
	}{
		{molten.MorphDesignTabRequest{Mod: "branch-box", TabName: "Conception · Branch box"}, "Conception · Branch box"},
		{molten.MorphDesignTabRequest{Mod: "branch-box", Name: "Branch box"}, "Design · Branch box"},
		{molten.MorphDesignTabRequest{Mod: "branch-box"}, "Design · branch-box"},
	}
	for _, c := range cases {
		if got := tabName(c.req); got != c.want {
			t.Errorf("tabName(%+v) = %q, want %q", c.req, got, c.want)
		}
	}
}
