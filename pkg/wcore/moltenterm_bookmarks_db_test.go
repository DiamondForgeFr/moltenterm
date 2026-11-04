// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/bookmarks"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
)

// The web page bookmarks of a project (FR-BRW-019) are keyed by its id, and the next project added takes a freed id: a
// removed project's bookmarks must go with it, and the other projects' stay.
func TestRemovingAProjectDropsItsBookmarksAndKeepsTheOthers(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	meta := notuliaMeta()
	meta[molten.BookmarksMetaKey] = map[string]any{
		"p1": map[string]any{"items": []any{map[string]any{"id": "b1", "url": "https://desktop.example.com/", "title": "Desktop docs"}}},
		"p2": map[string]any{"items": []any{map[string]any{"id": "b2", "url": "https://site.example.com/", "title": "Site"}}},
	}
	wsId := makeProjectWorkspace(t, ctx, meta)
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if got := bookmarks.Read(ws.Meta, "p2"); len(got) != 0 {
		t.Fatalf("a removed project keeps its bookmarks, which the next project of that id would inherit: %+v", got)
	}
	if got := bookmarks.Read(ws.Meta, "p1"); len(got) != 1 || got[0].Title != "Desktop docs" {
		t.Fatalf("the other project's bookmarks stay: %+v", got)
	}
}

func TestRemovingTheLastProjectWithBookmarksDeletesTheKey(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	meta := notuliaMeta()
	meta[molten.BookmarksMetaKey] = map[string]any{
		"p2": map[string]any{"items": []any{map[string]any{"id": "b2", "url": "https://site.example.com/", "title": "Site"}}},
	}
	wsId := makeProjectWorkspace(t, ctx, meta)
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	if workspaceOf(t, ctx, wsId).Meta.HasKey(molten.BookmarksMetaKey) {
		t.Fatal("no project has bookmarks any more: the key goes")
	}
}
