// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// The commands #1426 builds on: a terminal lists and declares for its own project; a window lists by workspace or
// drawer, renames, pins, deletes the copy and undoes it.
func TestRouteCommands(t *testing.T) {
	h := makeHarness(t)
	l := &routeLink{r: h.r}
	term := localroute.Caller{IsLocalTerminal: true, BlockId: "block-1"}
	window := localroute.Caller{IsWindow: true, TabId: "tab-1"}
	path := h.write("r.md", "# Report")

	if _, err := l.handle(molten.MaterialAddCommand, term, molten.MaterialsRequest{BlockId: "block-2", Target: path}); err == nil {
		t.Errorf("a terminal declared for another terminal")
	}
	out, err := l.handle(molten.MaterialAddCommand, term, molten.MaterialsRequest{BlockId: "block-1", Target: path})
	if err != nil {
		t.Fatal(err)
	}
	m := out.(molten.Material)
	if m.Source != molten.MaterialSourceDeclared {
		t.Errorf("source %s", m.Source)
	}
	out, err = l.handle(molten.MaterialsListCommand, term, molten.MaterialsRequest{BlockId: "block-1"})
	if err != nil {
		t.Fatal(err)
	}
	view := out.(molten.MaterialsView)
	if len(view.Materials) != 1 || view.Project.Key != h.key() || view.Project.Name != "project" || view.Usage.ProjectCap != DefaultLimits().ProjectCap {
		t.Errorf("view %+v", view)
	}
	out, err = l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{WorkspaceId: "ws-1", All: true})
	if err != nil || len(out.(molten.MaterialsView).Projects) != 1 {
		t.Errorf("window list: %+v %v", out, err)
	}
	if _, err := l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{Project: "../etc"}); err == nil {
		t.Errorf("an invalid drawer key was accepted")
	}
	out, err = l.handle(molten.MaterialRenameCommand, window, molten.MaterialsRequest{Id: m.Id, Title: "Rapport"})
	if err != nil || out.(molten.Material).Title != "Rapport" {
		t.Errorf("rename %+v %v", out, err)
	}
	out, err = l.handle(molten.MaterialPinCommand, window, molten.MaterialsRequest{Id: m.Id, Pinned: true})
	if err != nil || !out.(molten.Material).Pinned {
		t.Errorf("pin %+v %v", out, err)
	}
	out, err = l.handle(molten.MaterialDeleteCopyCommand, window, molten.MaterialsRequest{Id: m.Id})
	if err != nil {
		t.Fatal(err)
	}
	trash := out.(molten.MaterialDeleted).TrashId
	out, err = l.handle(molten.MaterialRestoreCommand, window, molten.MaterialsRequest{TrashId: trash})
	if err != nil || out.(molten.Material).Id != m.Id {
		t.Errorf("restore %+v %v", out, err)
	}
	out, err = l.handle(molten.MaterialGetCommand, window, molten.MaterialsRequest{Id: m.Id})
	if err != nil || out.(molten.Material).CopyPath == "" {
		t.Errorf("get %+v %v", out, err)
	}
	// The policy: changes are a window's; reading and declaring are a terminal's too.
	policy := l.route().Policy
	for _, cmd := range []string{molten.MaterialRenameCommand, molten.MaterialPinCommand, molten.MaterialDeleteCopyCommand, molten.MaterialRestoreCommand, molten.MaterialCopyCommand} {
		if policy.Admits(cmd, term) {
			t.Errorf("a terminal may send %s", cmd)
		}
	}
	for _, cmd := range []string{molten.MaterialsListCommand, molten.MaterialAddCommand} {
		if !policy.Admits(cmd, term) || policy.Admits(cmd, localroute.Caller{}) {
			t.Errorf("policy of %s", cmd)
		}
	}
}

// A window asking for every project gets the materials of each drawer, each naming its own (the project filter of the
// Materials section, #1816).
func TestListAllProjectsMaterials(t *testing.T) {
	h := makeHarness(t)
	l := &routeLink{r: h.r}
	window := localroute.Caller{IsWindow: true, TabId: "tab-1"}
	other := filepath.Join(filepath.Dir(h.project), "other")
	os.MkdirAll(other, 0o755)
	otherKey, otherFolder := ProjectKey(other)
	own := h.write("own.md", "# Own")
	foreign := h.write("foreign.md", "# Foreign")
	if _, _, err := h.r.capture(Capture{Project: h.key(), Folder: h.project, Source: molten.MaterialSourceBrought, Path: own}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.r.capture(Capture{Project: otherKey, Folder: otherFolder, Source: molten.MaterialSourceBrought, Path: foreign}); err != nil {
		t.Fatal(err)
	}
	out, err := l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{WorkspaceId: "ws-1"})
	if err != nil || len(out.(molten.MaterialsView).Materials) != 1 {
		t.Fatalf("without All, the workspace's drawer only: %+v %v", out, err)
	}
	out, err = l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{WorkspaceId: "ws-1", All: true})
	if err != nil {
		t.Fatal(err)
	}
	view := out.(molten.MaterialsView)
	if view.Project.Key != h.key() || len(view.Projects) != 2 || len(view.Materials) != 2 {
		t.Fatalf("view %+v", view)
	}
	keys := map[string]bool{}
	for _, m := range view.Materials {
		keys[m.Project] = true
	}
	if !keys[h.key()] || !keys[otherKey] {
		t.Errorf("each material names its drawer: %v", keys)
	}
	out, err = l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{WorkspaceId: "ws-1", Summary: true})
	if err != nil {
		t.Fatal(err)
	}
	summary := out.(molten.MaterialsView)
	if len(summary.Materials) != 0 || len(summary.Projects) != 2 {
		t.Fatalf("project summaries must not include full records: %+v", summary)
	}
	for _, project := range summary.Projects {
		if project.Count != 1 {
			t.Errorf("project %s count = %d, want 1", project.Key, project.Count)
		}
	}
	out, err = l.handle(molten.MaterialsListCommand, window, molten.MaterialsRequest{Project: otherKey})
	if err != nil || len(out.(molten.MaterialsView).Materials) != 1 || out.(molten.MaterialsView).Materials[0].Project != otherKey {
		t.Fatalf("selected drawer only: %+v %v", out, err)
	}
	term := localroute.Caller{IsLocalTerminal: true, BlockId: "block-1"}
	out, err = l.handle(molten.MaterialsListCommand, term, molten.MaterialsRequest{BlockId: "block-1", All: true, Summary: true})
	if err != nil || len(out.(molten.MaterialsView).Materials) != 1 {
		t.Errorf("a terminal never reads the other projects: %+v %v", out, err)
	}
}
