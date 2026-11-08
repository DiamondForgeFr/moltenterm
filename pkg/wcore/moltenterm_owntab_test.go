// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// FR-BOSS-009, AC26 (#2033): Brokk's own tab is a hidden agent tab that shows when the developer is taken to it on
// purpose, and never stays among the views once he leaves it.
func TestBrokksTabIsHiddenAgainOnceTheDeveloperLeavesIt(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, nil)
	work := addProjectTab(t, ctx, wsId, "work", nil, "")
	brokk, err := CreateAgentTab(ctx, wsId, "Brokk", waveobj.MetaMapType{molten.OwnSessionMetaKey: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	other := addProjectTab(t, ctx, wsId, "other", nil, "")
	if !slices.Contains(molten.HiddenTabIds(workspaceOf(t, ctx, wsId)), brokk) {
		t.Fatalf("his tab starts hidden")
	}
	if err := SetActiveTab(ctx, wsId, work); err != nil {
		t.Fatal(err)
	}

	if err := SetActiveTab(ctx, wsId, brokk); err != nil {
		t.Fatal(err)
	}
	shown := workspaceOf(t, ctx, wsId)
	if shown.ActiveTabId != brokk || slices.Contains(molten.HiddenTabIds(shown), brokk) {
		t.Fatalf("active tab %q, hidden %v: want his tab shown while the developer is in it", shown.ActiveTabId, molten.HiddenTabIds(shown))
	}

	if err := SetActiveTab(ctx, wsId, other); err != nil {
		t.Fatal(err)
	}
	got := workspaceOf(t, ctx, wsId)
	if !slices.Contains(molten.HiddenTabIds(got), brokk) {
		t.Fatalf("hidden %v, want his tab hidden again once he left it", molten.HiddenTabIds(got))
	}
	if slices.Contains(molten.HiddenTabIds(got), work) || slices.Contains(molten.HiddenTabIds(got), other) {
		t.Errorf("hidden %v, want the developer's views left alone", molten.HiddenTabIds(got))
	}
}
