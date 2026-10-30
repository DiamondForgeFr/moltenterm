// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
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
