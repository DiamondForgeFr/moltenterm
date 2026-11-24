// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// oneViewWindow is a window whose workspace holds one view with one terminal: the state where closing that terminal
// quit MoltenTerm (#2517).
func oneViewWindow(t *testing.T, ctx context.Context) (string, string, string, string) {
	t.Helper()
	wsId := makeProjectWorkspace(t, ctx, nil)
	tabId := addProjectTab(t, ctx, wsId, "T1", nil, "/tmp")
	activate(t, ctx, wsId, tabId)
	windowId := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Window{OID: windowId, WorkspaceId: wsId}); err != nil {
		t.Fatal(err)
	}
	client := &waveobj.Client{OID: uuid.NewString(), WindowIds: []string{windowId}}
	if err := wstore.DBInsert(ctx, client); err != nil {
		t.Fatal(err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil || len(tab.BlockIds) != 1 {
		t.Fatalf("one terminal in the view: %+v, %v", tab, err)
	}
	return wsId, windowId, tabId, tab.BlockIds[0]
}

// assertChooserView checks that the window stays and shows one new view holding the chooser, and returns that view.
func assertChooserView(t *testing.T, ctx context.Context, wsId string, windowId string, closedTabId string) string {
	t.Helper()
	win, _ := wstore.DBGet[*waveobj.Window](ctx, windowId)
	if win == nil {
		t.Fatal("the window must stay open")
	}
	ws := workspaceOf(t, ctx, wsId)
	if len(ws.TabIds) != 1 || ws.TabIds[0] == closedTabId {
		t.Fatalf("one new view in place of the closed one, got %v", ws.TabIds)
	}
	if ws.ActiveTabId != ws.TabIds[0] {
		t.Fatalf("the new view is shown: active %q, tabs %v", ws.ActiveTabId, ws.TabIds)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, ws.TabIds[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(tab.BlockIds) != 1 {
		t.Fatalf("the new view holds the chooser alone, got %v", tab.BlockIds)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatal(err)
	}
	if block.Meta.GetString(waveobj.MetaKey_View, "") != "launcher" || block.Meta[NewViewChooserMetaKey] != true {
		t.Fatalf("the new view shows the chooser of a new view, got %v", block.Meta)
	}
	return tab.OID
}

func TestClosingTheLastPanelOfTheLastViewKeepsTheWindowOnTheChooser(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId, windowId, tabId, blockId := oneViewWindow(t, ctx)
	if err := DeleteBlock(ctx, blockId, true); err != nil {
		t.Fatal(err)
	}
	assertChooserView(t, ctx, wsId, windowId, tabId)
}

func TestClosingTheLastViewKeepsTheWindowOnTheChooser(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId, windowId, tabId, _ := oneViewWindow(t, ctx)
	next, err := DeleteTab(ctx, wsId, tabId, true)
	if err != nil {
		t.Fatal(err)
	}
	if shown := assertChooserView(t, ctx, wsId, windowId, tabId); next != shown {
		t.Fatalf("the new view is the one to show: %q, want %q", next, shown)
	}
}

func TestClosingAViewAmongOthersOpensNoChooser(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId, _, tabId, _ := oneViewWindow(t, ctx)
	other := addProjectTab(t, ctx, wsId, "T2", nil, "/tmp")
	next, err := DeleteTab(ctx, wsId, tabId, true)
	if err != nil {
		t.Fatal(err)
	}
	if next != other {
		t.Fatalf("the other view is shown: %q, want %q", next, other)
	}
	if tabs := workspaceOf(t, ctx, wsId).TabIds; len(tabs) != 1 || tabs[0] != other {
		t.Fatalf("no new view while another remains, got %v", tabs)
	}
}

func TestClosingTheWindowStillClosesIt(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	_, windowId, _, _ := oneViewWindow(t, ctx)
	if err := CloseWindow(ctx, windowId, true); err != nil {
		t.Fatal(err)
	}
	if win, _ := wstore.DBGet[*waveobj.Window](ctx, windowId); win != nil {
		t.Fatal("closing the window is explicit and still closes it")
	}
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(client.WindowIds) != 0 {
		t.Fatalf("the client forgets the closed window, got %v", client.WindowIds)
	}
}
