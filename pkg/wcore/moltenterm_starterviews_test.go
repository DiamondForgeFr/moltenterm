// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func pinnedViews(t *testing.T, ctx context.Context, ws *waveobj.Workspace) []*waveobj.Tab {
	t.Helper()
	var rtn []*waveobj.Tab
	for _, tabId := range ws.TabIds {
		tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
		if err != nil {
			t.Fatal(err)
		}
		if tab.Meta.GetString(viewpin.PinMetaKey, "") == viewpin.PinWorkspace {
			rtn = append(rtn, tab)
		}
	}
	return rtn
}

func TestAddWorkspaceViewsToAnExistingWorkspace(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := CreateWorkspace(ctx, "Starter", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	activeBefore := ws.ActiveTabId
	tabsBefore := len(ws.TabIds)

	first, err := addWorkspaceViews(ctx, ws.OID, defaultTemplate)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ws.TabIds) != tabsBefore+2 || ws.ActiveTabId != activeBefore {
		t.Fatalf("two views added after the existing one, the active view kept: %+v", ws)
	}
	pinned := pinnedViews(t, ctx, ws)
	if len(pinned) != 2 || pinned[0].OID != first {
		t.Fatalf("the template's views, pinned in the workspace, the first returned: %d %q", len(pinned), first)
	}
	if pinned[0].Meta[ViewPendingMetaKey] != true || pinned[0].Meta.GetString(ViewNameKeyMetaKey, "") != "workspaceViews.names.scoping" {
		t.Fatalf("a pending view named by its key: %v", pinned[0].Meta)
	}
	if !ws.Meta.GetBool(mission.TemplateViewsMetaKey, false) {
		t.Fatalf("the workspace is marked as made from the template: %v", ws.Meta)
	}

	again, err := addWorkspaceViews(ctx, ws.OID, defaultTemplate)
	if err != nil {
		t.Fatalf("add again: %v", err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if again != first || len(ws.TabIds) != tabsBefore+2 {
		t.Fatalf("adding again makes no second copy: %q %d", again, len(ws.TabIds))
	}
}

func TestAddWorkspaceViewsKeepsRenamedViewsApart(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := CreateWorkspace(ctx, "", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	typed := []wconfig.NewWorkspaceViewType{{Name: "Docs", Panels: []string{"browser"}}}
	if _, err := addWorkspaceViews(ctx, ws.OID, typed); err != nil {
		t.Fatal(err)
	}
	if _, err := addWorkspaceViews(ctx, ws.OID, typed); err != nil {
		t.Fatal(err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got := pinnedViews(t, ctx, ws); len(got) != 1 || got[0].Name != "Docs" {
		t.Fatalf("a typed name is matched as typed: %d", len(got))
	}
}

func TestAddWorkspaceViewsEmptyTemplate(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := CreateWorkspace(ctx, "", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := addWorkspaceViews(ctx, ws.OID, nil)
	if err != nil || first != "" {
		t.Fatalf("nothing to add: %q %v", first, err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if ws.Meta.GetBool(mission.TemplateViewsMetaKey, false) {
		t.Fatalf("no view added, no mark: %v", ws.Meta)
	}
}

// AC-3 of FR-SHELL-110: the starter workspace, given the template's views, gets no Project tab when its project is
// linked.
func TestStarterWorkspaceGetsNoProjectTab(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := CreateWorkspace(ctx, "", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := setTemplateMark(ctx, ws.OID); err != nil {
		t.Fatal(err)
	}
	oref := waveobj.MakeORef(waveobj.OType_Workspace, ws.OID)
	if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{molten.ProjectMetaKey: "/tmp/p"}, false); err != nil {
		t.Fatal(err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got := mission.DecideProjectTab(readProjectTabFacts(ctx, ws, false), false); got != mission.ProjectTabNone {
		t.Fatalf("a starter workspace linked during First steps gets no Project tab: %q", got)
	}
}
