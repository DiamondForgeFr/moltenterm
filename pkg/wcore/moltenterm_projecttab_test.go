// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A new Project tab holds the project view on the left, focused, and Pilotage on its right at the same size (#1177).
func TestProjectTabLayout(t *testing.T) {
	layout := projectTabLayout()
	if len(layout) != 2 {
		t.Fatalf("got %d panes, want the project view and Pilotage", len(layout))
	}
	project, pilotage := layout[0], layout[1]
	if !slices.Equal(project.IndexArr, []int{0}) || !project.Focused ||
		project.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != mission.ProjectView {
		t.Errorf("project view: %+v", project)
	}
	if !slices.Equal(pilotage.IndexArr, []int{1}) || pilotage.Focused ||
		pilotage.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != mission.PilotageView {
		t.Errorf("Pilotage: %+v", pilotage)
	}
	if project.Size != nil || pilotage.Size != nil {
		t.Errorf("the panes start at the same size: %v, %v", project.Size, pilotage.Size)
	}
	// Pilotage reads the workspace's project: a project of its own would go stale when the workspace is relinked.
	if len(pilotage.BlockDef.Meta) != 1 {
		t.Errorf("Pilotage's meta: %+v", pilotage.BlockDef.Meta)
	}
}

// Restoring the project view brings back the project view alone, never Pilotage: closing it was the user's choice.
func TestRestoredProjectViewIsAlone(t *testing.T) {
	def := projectTabBlockDef()
	if def.Meta.GetString(waveobj.MetaKey_View, "") != mission.ProjectView || len(def.Meta) != 1 {
		t.Errorf("restored block: %+v", def.Meta)
	}
}

// An existing Project tab is kept as it is: only a decision to create lays a tab out.
func TestExistingProjectTabIsNotLaidOut(t *testing.T) {
	existing := []mission.ProjectTabFacts{
		{Dir: "/p", RecordedDir: "/p", TabId: "t", HasView: true},
		{Dir: "/p", RecordedDir: "/p", TabId: "t"},
		{Dir: "/q", RecordedDir: "/p", TabId: "t", HasView: true},
	}
	for _, facts := range existing {
		for _, open := range []bool{false, true} {
			if got := mission.DecideProjectTab(facts, open); got == mission.ProjectTabCreate {
				t.Errorf("facts %+v, open %v: an existing tab would be made again", facts, open)
			}
		}
	}
}
