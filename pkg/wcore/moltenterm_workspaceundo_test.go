// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func setUndoClock(t *testing.T, at time.Time) {
	t.Helper()
	saved := workspaceUndoNow
	workspaceUndoNow = func() time.Time { return at }
	t.Cleanup(func() { workspaceUndoNow = saved })
}

func makeUndoWorkspace(t *testing.T, ctx context.Context) *waveobj.Workspace {
	t.Helper()
	setUndoClock(t, time.Unix(1_800_000_000, 0))
	ws := &waveobj.Workspace{OID: "11111111-2222-3333-4444-555555555555", TabIds: []string{}, Name: "Mine", Icon: "star", Color: "#e54d2e",
		Meta: waveobj.MetaMapType{"molten:project": "/tmp/proj"}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Scoping", "Pilotage"} {
		tab, err := createTabObj(ctx, ws.OID, name, waveobj.MetaMapType{"molten:view": name})
		if err != nil {
			t.Fatal(err)
		}
		block, err := CreateBlockWithTelemetry(ctx, tab.OID, &waveobj.BlockDef{Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:          "term",
			waveobj.MetaKey_Controller:    "cmd",
			waveobj.MetaKey_CmdRunOnStart: true,
			reopen.ResumeAgentMetaKey:     "claude",
		}}, &waveobj.RuntimeOpts{}, false)
		if err != nil {
			t.Fatal(err)
		}
		if err := wstore.DBUpdateFn(ctx, tab.LayoutState, func(l *waveobj.LayoutState) {
			l.RootNode = map[string]any{"id": "n1", "data": map[string]any{"blockId": block.OID}}
		}); err != nil {
			t.Fatal(err)
		}
	}
	ws, err := GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetActiveTab(ctx, ws.OID, ws.TabIds[1]); err != nil {
		t.Fatal(err)
	}
	return ws
}

func tabNames(t *testing.T, ctx context.Context, wsId string) []string {
	t.Helper()
	ws, err := GetWorkspace(ctx, wsId)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, id := range ws.TabIds {
		tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tab.Name)
	}
	return names
}

func TestUndoDeleteBringsTheWorkspaceBackUnderItsId(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws := makeUndoWorkspace(t, ctx)
	iconName := ws.OID + "-0123456789ab.png"
	iconDir := molten.WorkspaceIconsDir()
	if err := os.MkdirAll(iconDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(iconDir, iconName), []byte("png"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := setWorkspaceIconMeta(ctx, ws.OID, iconName); err != nil {
		t.Fatal(err)
	}
	undoId, err := CaptureWorkspaceUndo(ctx, ws.OID, WorkspaceUndoKindDelete, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := DeleteWorkspace(ctx, ws.OID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(iconDir, iconName)); !os.IsNotExist(err) {
		t.Fatalf("the delete removes the icon file: %v", err)
	}
	offer := PendingWorkspaceUndo("win-1")
	if offer == nil || offer.UndoId != undoId || offer.Kind != WorkspaceUndoKindDelete || offer.Name != "Mine" || offer.RemainingMs <= 0 {
		t.Fatalf("the window that deleted is offered undo: %+v", offer)
	}
	if PendingWorkspaceUndo("win-2") != nil {
		t.Fatal("another window is not offered the undo")
	}
	rtn, err := RestoreWorkspaceUndo(ctx, undoId)
	if err != nil {
		t.Fatal(err)
	}
	got, err := GetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatalf("the workspace is back under its id: %v", err)
	}
	if got.Name != "Mine" || got.Icon != "star" || got.Color != "#e54d2e" || got.Meta.GetString("molten:project", "") != "/tmp/proj" {
		t.Fatalf("identity and project link are back: %+v", got)
	}
	if names := tabNames(t, ctx, ws.OID); len(names) != 2 || names[0] != "Scoping" || names[1] != "Pilotage" {
		t.Fatalf("views back in order: %v", names)
	}
	if rtn.ActiveTabId != got.TabIds[1] || got.ActiveTabId != got.TabIds[1] || len(rtn.ClosedTabIds) != 0 {
		t.Fatalf("the active view is the one that was: %+v / %+v", rtn, got)
	}
	if _, err := os.Stat(filepath.Join(iconDir, iconName)); err != nil {
		t.Fatalf("the imported icon is back: %v", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, got.TabIds[0])
	if err != nil {
		t.Fatal(err)
	}
	if tab.Meta.GetString("molten:view", "") != "Scoping" || len(tab.BlockIds) != 1 {
		t.Fatalf("the view keeps its meta and its pane: %+v", tab)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := block.Meta[reopen.ResumeAgentMetaKey]; ok || block.Meta.GetBool(waveobj.MetaKey_CmdRunOnStart, true) {
		t.Fatalf("nothing that ran starts again: %v", block.Meta)
	}
	if _, err := RestoreWorkspaceUndo(ctx, undoId); err == nil {
		t.Fatal("an undo runs once")
	}
}

func TestUndoResetGivesTheViewsBack(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws := makeUndoWorkspace(t, ctx)
	undoId, err := CaptureWorkspaceUndo(ctx, ws.OID, WorkspaceUndoKindReset, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	freshTabId, err := ResetWorkspace(ctx, ws.OID)
	if err != nil {
		t.Fatal(err)
	}
	rtn, err := RestoreWorkspaceUndo(ctx, undoId)
	if err != nil {
		t.Fatal(err)
	}
	if len(rtn.ClosedTabIds) != 1 || rtn.ClosedTabIds[0] != freshTabId {
		t.Fatalf("the fresh view the reset made goes: %+v", rtn)
	}
	if names := tabNames(t, ctx, ws.OID); len(names) != 2 || names[0] != "Scoping" || names[1] != "Pilotage" {
		t.Fatalf("views back: %v", names)
	}
}

func TestUndoOfferEnds(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	ws := makeUndoWorkspace(t, ctx)
	undoId, err := CaptureWorkspaceUndo(ctx, ws.OID, WorkspaceUndoKindReset, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	setUndoClock(t, workspaceUndoNow().Add(WorkspaceUndoWindow))
	if PendingWorkspaceUndo("win-1") != nil {
		t.Fatal("no offer once the undo window is over")
	}
	if _, err := RestoreWorkspaceUndo(ctx, "not-"+undoId); err == nil {
		t.Fatal("an unknown undo is refused")
	}
	setUndoClock(t, workspaceUndoNow().Add(workspaceUndoGrace+time.Second))
	if PendingWorkspaceUndo("win-1") != nil {
		t.Fatal("no offer after the undo window")
	}
	if _, err := RestoreWorkspaceUndo(ctx, undoId); err == nil {
		t.Fatal("no undo after the undo window")
	}
}

func TestUndoDeleteKeepsTheSidebarPlace(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	if _, err := wstore.DBGetSingleton[*waveobj.Client](ctx); err != nil {
		if err := wstore.DBInsert(ctx, &waveobj.Client{OID: "client-1"}); err != nil {
			t.Fatal(err)
		}
	}
	ws := makeUndoWorkspace(t, ctx)
	before, err := CreateWorkspace(ctx, "Before", "star", "#000001", false, false)
	if err != nil {
		t.Fatal(err)
	}
	after, err := CreateWorkspace(ctx, "After", "star", "#000002", false, false)
	if err != nil {
		t.Fatal(err)
	}
	// No order stored yet (the user never moved a workspace): the list is in creation order, so a workspace made
	// again would come last.
	var want []string
	listed, err := ListWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range listed {
		want = append(want, entry.WorkspaceId)
	}
	if len(want) != 3 || want[len(want)-1] == ws.OID {
		t.Fatalf("the deleted workspace is not the last one: %v (%s %s)", want, before.OID, after.OID)
	}
	undoId, err := CaptureWorkspaceUndo(ctx, ws.OID, WorkspaceUndoKindDelete, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := DeleteWorkspace(ctx, ws.OID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreWorkspaceUndo(ctx, undoId); err != nil {
		t.Fatal(err)
	}
	list, err := ListWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, entry := range list {
		got = append(got, entry.WorkspaceId)
	}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("back at its place in the sidebar: got %v, want %v", got, want)
	}
}
