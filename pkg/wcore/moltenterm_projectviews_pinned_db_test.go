// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRemovingAProjectTurnsADuplicatePinnedViewIntoATemporaryViewOrDropsItsUnopenedPlaceholder(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	tile := addProjectTab(t, ctx, wsId, "Cadrage", commandTileMeta(), notuliaDir)
	other := addProjectTab(t, ctx, wsId, "Pilotage", pinnedTabMeta(), notuliaDir)
	activate(t, ctx, wsId, tile)
	res, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p2"})
	if err != nil {
		t.Fatal(err)
	}
	opened := res.TabId
	if _, _, err := openPendingView(ctx, opened); err != nil {
		t.Fatal(err)
	}
	// The developer opened Cadrage on p2: it has a panel now. Pilotage's instance in p2 was never shown.
	block := &waveobj.Block{OID: uuid.NewString(), ParentORef: waveobj.MakeORef(waveobj.OType_Tab, opened).String(), Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	stored, _ := wstore.DBGet[*waveobj.Tab](ctx, opened)
	stored.BlockIds = append(stored.BlockIds, block.OID)
	if err := wstore.DBUpdate(ctx, stored); err != nil {
		t.Fatal(err)
	}
	if before := workspaceOf(t, ctx, wsId).TabIds; len(before) != 4 {
		t.Fatalf("two tiles and p2's two instances: %v", before)
	}

	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if len(ws.TabIds) != 3 || !slices.Contains(ws.TabIds, opened) {
		t.Fatalf("only the placeholder never shown goes: %v", ws.TabIds)
	}
	duplicate, _ := wstore.DBGet[*waveobj.Tab](ctx, opened)
	if isTileMeta(duplicate.Meta) || len(duplicate.BlockIds) != 1 || duplicate.Meta.HasKey(projectviews.SiblingMetaKey) {
		t.Fatalf("the opened duplicate keeps its panel and becomes a temporary view: %+v", duplicate)
	}
	if t0, _ := wstore.DBGet[*waveobj.Tab](ctx, tile); t0 == nil || !isTileMeta(t0.Meta) {
		t.Fatalf("p1's tile is untouched")
	}
	if t1, _ := wstore.DBGet[*waveobj.Tab](ctx, other); t1 == nil || !isTileMeta(t1.Meta) {
		t.Fatalf("the other tile is untouched")
	}
	if ws.Meta.HasKey(projectviews.SlotsMetaKey) || ws.Meta.HasKey(projectviews.TabProjectsMetaKey) {
		t.Fatalf("one project left maps nothing: %v", ws.Meta)
	}
}

func TestAReopenedTileComesBackToItsProjectAndItsSlot(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	tile := addProjectTab(t, ctx, wsId, "Cadrage", commandTileMeta(), notuliaDir)
	slot := projectviews.ReadSlots(workspaceOf(t, ctx, wsId).Meta)[tile]
	if slot == "" {
		t.Fatal("the tile has a slot")
	}
	recorded := moltenTabMetaWithProject(workspaceOf(t, ctx, wsId), tile, reopenCleanMeta(t, ctx, tile))
	if recorded[projectviews.SlotHintMetaKey] != slot || recorded[projectviews.ViewProjectHintMetaKey] != "p1" {
		t.Fatalf("the record carries the project and the slot: %v", recorded)
	}
	// Made again while the other project is current: it still goes back to its own project and slot.
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	again, err := createTabObj(ctx, wsId, "Cadrage", recorded)
	if err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if projectviews.ReadTabProjects(ws.Meta)[again.OID] != "p1" || projectviews.ReadSlots(ws.Meta)[again.OID] != slot {
		t.Fatalf("back in p1 with its slot: %v", ws.Meta)
	}
	if stored, _ := wstore.DBGet[*waveobj.Tab](ctx, again.OID); stored.Meta.HasKey(projectviews.SlotHintMetaKey) || stored.Meta.HasKey(projectviews.ViewProjectHintMetaKey) {
		t.Fatalf("the hints never stay on the tab: %v", stored.Meta)
	}
}

func TestInstancesPinnedTogetherShareTheSlotTheWindowNames(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a := addProjectTab(t, ctx, wsId, "a", nil, notuliaDir)
	b := addProjectTab(t, ctx, wsId, "b", nil, notuliaDir)
	for _, id := range []string{a, b} {
		patch := waveobj.MetaMapType{viewpin.PinMetaKey: viewpin.PinWorkspace, viewpin.PinConfigMetaKey: pinnedTabMeta()[viewpin.PinConfigMetaKey], projectviews.SlotHintMetaKey: "sShared"}
		if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Tab, id), patch, false); err != nil {
			t.Fatal(err)
		}
		MoltenTabMetaChanged(ctx, id, patch)
		if stored, _ := wstore.DBGet[*waveobj.Tab](ctx, id); stored.Meta.HasKey(projectviews.SlotHintMetaKey) {
			t.Fatalf("the hint never stays on the tab: %v", stored.Meta)
		}
	}
	slots := projectviews.ReadSlots(workspaceOf(t, ctx, wsId).Meta)
	if slots[a] != "sShared" || slots[b] != "sShared" {
		t.Fatalf("both are instances of one slot: %v", slots)
	}
}

func reopenCleanMeta(t *testing.T, ctx context.Context, tabId string) waveobj.MetaMapType {
	t.Helper()
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	return reopen.CleanMeta(tab.Meta)
}

// A workspace the first part migrated (its temporary views mapped, its pinned views shared) gets its pinned views'
// projects and slots at the next start, in workspace meta only, and nothing else changes.
func TestStartupAssignmentOfThePinnedViewsAfterThePartOneMigration(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	meta := notuliaMeta()
	meta[projectviews.AssignedMetaKey] = true
	wsId := makeProjectWorkspace(t, ctx, meta)
	tab := &waveobj.Tab{OID: uuid.NewString(), Name: "Cadrage", Meta: commandTileMeta(), LayoutState: uuid.NewString()}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	ws.TabIds = []string{tab.OID}
	ws.ActiveTabId = tab.OID
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if err := AssignProjectViewsAtStartup(ctx); err != nil {
		t.Fatal(err)
	}
	ws = workspaceOf(t, ctx, wsId)
	if projectviews.ReadTabProjects(ws.Meta)[tab.OID] != "p1" || projectviews.ReadSlots(ws.Meta)[tab.OID] == "" ||
		!ws.Meta.GetBool(projectviews.AssignedPinnedMetaKey, false) {
		t.Fatalf("the tile gets its project and its slot: %v", ws.Meta)
	}
	snapshot := ws.Meta
	if err := AssignProjectViewsAtStartup(ctx); err != nil {
		t.Fatal(err)
	}
	if again := workspaceOf(t, ctx, wsId); !reflect.DeepEqual(again.Meta, snapshot) {
		t.Fatalf("a second start changes nothing: %v, was %v", again.Meta, snapshot)
	}
	if stored, _ := wstore.DBGet[*waveobj.Tab](ctx, tab.OID); len(stored.Meta) != len(commandTileMeta()) {
		t.Fatalf("the tab's own meta is not written: %v", stored.Meta)
	}
}
