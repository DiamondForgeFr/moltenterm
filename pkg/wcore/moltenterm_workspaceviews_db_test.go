// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func initWorkspaceViewStores(t *testing.T) {
	t.Helper()
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })
	if err := os.MkdirAll(filepath.Join(dataDir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatal(err)
	}
	if err := filestore.InitFilestore(); err != nil {
		t.Fatal(err)
	}
}

func countObjs[T waveobj.WaveObj](t *testing.T, ctx context.Context, otype string) int {
	t.Helper()
	objs, err := wstore.DBGetAllObjsByType[T](ctx, otype)
	if err != nil {
		t.Fatalf("listing %s: %v", otype, err)
	}
	return len(objs)
}

var defaultTemplate = []wconfig.NewWorkspaceViewType{
	{NameKey: "workspaceViews.names.scoping", Panels: []string{"agent", "browser", "files"}},
	{NameKey: "workspaceViews.names.pilotage", Panels: []string{"project", "integration"}},
}

func TestCreateWorkspaceWithViewsHoldsOnlyTheTemplate(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := createWorkspaceWithViews(ctx, "Mine", "", "", true, defaultTemplate)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ws.TabIds) != 2 {
		t.Fatalf("only the template's views, got %d tabs", len(ws.TabIds))
	}
	names := []string{"workspaceViews.names.scoping", "workspaceViews.names.pilotage"}
	for i, tabId := range ws.TabIds {
		tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
		if err != nil {
			t.Fatal(err)
		}
		if tab.Name != names[i] || tab.Meta[ViewPendingMetaKey] != true || len(tab.BlockIds) != 0 {
			t.Fatalf("view %d in template order, pending, without panels: %+v", i, tab)
		}
		if tab.Meta.GetString(viewpin.PinMetaKey, "") != viewpin.PinWorkspace {
			t.Fatalf("view %d pinned in the workspace: %v", i, tab.Meta)
		}
		if _, build := pendingViewConfig(tab); !build {
			t.Fatalf("view %d opens on first show", i)
		}
	}
	if ws.ActiveTabId != ws.TabIds[0] {
		t.Fatalf("the first template view is active: %q, tabs %v", ws.ActiveTabId, ws.TabIds)
	}
	if ws.Name != "Mine" || ws.Color == "" || ws.Icon == "" {
		t.Fatalf("name and defaults applied: %+v", ws)
	}
	if !ws.Meta.GetBool(mission.TemplateViewsMetaKey, false) {
		t.Fatalf("marked as made from the template: %v", ws.Meta)
	}
	if n := countObjs[*waveobj.Tab](t, ctx, waveobj.OType_Tab); n != 2 {
		t.Fatalf("no tab left over: %d tabs", n)
	}
	if n := countObjs[*waveobj.LayoutState](t, ctx, waveobj.OType_LayoutState); n != 2 {
		t.Fatalf("no layout left over: %d layouts", n)
	}
	if n := countObjs[*waveobj.Block](t, ctx, waveobj.OType_Block); n != 0 {
		t.Fatalf("no block made: %d blocks", n)
	}
}

func TestCreateWorkspaceWithViewsEmptyTemplate(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	for _, views := range [][]wconfig.NewWorkspaceViewType{nil, {{Name: "Broken", Panels: []string{"nope"}}}} {
		ws, err := createWorkspaceWithViews(ctx, "", "", "", true, views)
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		ws, err = GetWorkspace(ctx, ws.OID)
		if err != nil {
			t.Fatal(err)
		}
		if len(ws.TabIds) != 1 || ws.ActiveTabId != ws.TabIds[0] {
			t.Fatalf("the usual single first view, active: %+v", ws)
		}
		tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, ws.TabIds[0])
		if err != nil {
			t.Fatal(err)
		}
		if tab.Meta[ViewPendingMetaKey] != nil || len(tab.BlockIds) != 1 {
			t.Fatalf("Wave's first tab with its terminal: %+v", tab)
		}
		if ws.Meta.GetBool(mission.TemplateViewsMetaKey, false) {
			t.Fatalf("a workspace without template views keeps its Project tab: %v", ws.Meta)
		}
	}
}

func TestTemplateWorkspaceGetsNoProjectTabUnasked(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws, err := createWorkspaceWithViews(ctx, "", "", "", true, defaultTemplate)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	oref := waveobj.MakeORef(waveobj.OType_Workspace, ws.OID)
	if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{molten.ProjectMetaKey: "/tmp/p"}, false); err != nil {
		t.Fatal(err)
	}
	ws, err = GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	facts := readProjectTabFacts(ctx, ws, false)
	if !facts.TemplateViews {
		t.Fatalf("facts read the template mark: %+v", facts)
	}
	if got := mission.DecideProjectTab(facts, false); got != mission.ProjectTabNone {
		t.Fatalf("a linked template workspace gets no Project tab on its own: %q", got)
	}
}
