// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type movedTabs struct {
	ctx       context.Context
	workspace string
}

// A workspace of two views, the first holding the panels named, each made as wavesrv makes one: its block's parent is
// its tab.
func twoViewsFixture(t *testing.T, panels ...string) movedTabs {
	t.Helper()
	ctx, ids := initContextsFixture(t, "views")
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, ids["views"])
	if err != nil {
		t.Fatal(err)
	}
	ws.TabIds = []string{"t1", "t2"}
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		t.Fatal(err)
	}
	first := &waveobj.Tab{OID: "t1", Name: "first", BlockIds: panels}
	if err := wstore.DBInsert(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: "t2", Name: "second", BlockIds: []string{}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range panels {
		block := &waveobj.Block{OID: id, ParentORef: waveobj.MakeORef(waveobj.OType_Tab, "t1").String()}
		if err := wstore.DBInsert(ctx, block); err != nil {
			t.Fatal(err)
		}
	}
	return movedTabs{ctx: ctx, workspace: ids["views"]}
}

func blockIdsOf(t *testing.T, ctx context.Context, tabId string) []string {
	t.Helper()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatal(err)
	}
	return tab.BlockIds
}

// #2548: an agent's panel moves into the new view with its block, so what runs in it keeps running.
func TestAPanelMovesIntoANewViewWithItsBlock(t *testing.T) {
	fx := twoViewsFixture(t, "b1", "b2")
	empty, err := moveBlockBetweenTabs(fx.ctx, "t1", "t2", "b2")
	if err != nil {
		t.Fatal(err)
	}
	if empty {
		t.Fatal("the first view still holds a panel")
	}
	if got := blockIdsOf(t, fx.ctx, "t1"); !slices.Equal(got, []string{"b1"}) {
		t.Fatalf("the view it left holds %v, want only b1", got)
	}
	if got := blockIdsOf(t, fx.ctx, "t2"); !slices.Equal(got, []string{"b2"}) {
		t.Fatalf("the new view holds %v, want b2", got)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](fx.ctx, "b2")
	if err != nil {
		t.Fatal(err)
	}
	if want := waveobj.MakeORef(waveobj.OType_Tab, "t2").String(); block.ParentORef != want {
		t.Fatalf("the block's parent is %q, want %q", block.ParentORef, want)
	}
}

func TestTheLastPanelOfAViewMovesAndLeavesItEmpty(t *testing.T) {
	fx := twoViewsFixture(t, "b1")
	empty, err := moveBlockBetweenTabs(fx.ctx, "t1", "t2", "b1")
	if err != nil {
		t.Fatal(err)
	}
	if !empty {
		t.Fatal("the view it left has no panel, and says so")
	}
}

func TestAPanelOnlyMovesFromTheViewThatHoldsIt(t *testing.T) {
	fx := twoViewsFixture(t, "b1")
	if _, err := moveBlockBetweenTabs(fx.ctx, "t1", "t2", "elsewhere"); err == nil {
		t.Fatal("a panel the view does not hold cannot be moved out of it")
	}
	if _, err := moveBlockBetweenTabs(fx.ctx, "t1", "t1", "b1"); err == nil {
		t.Fatal("a panel does not move into the view it is in")
	}
	if got := blockIdsOf(t, fx.ctx, "t1"); !slices.Equal(got, []string{"b1"}) {
		t.Fatalf("a refused move changed the view: %v", got)
	}
}
