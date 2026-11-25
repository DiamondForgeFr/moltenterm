// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/bookmarks"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The web page bookmarks (FR-BRW-019, #2531) are records placed at levels, kept in the client's meta. A removed project,
// workspace or context takes its places with it, and the next project that takes a freed id must not inherit them.

func putClientBookmarks(t *testing.T, ctx context.Context, raw string) {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		t.Fatalf("client: %v", err)
	}
	if client.Meta == nil {
		client.Meta = waveobj.MetaMapType{}
	}
	client.Meta[molten.BookmarksMetaKey] = value
	if err := wstore.DBUpdate(ctx, client); err != nil {
		t.Fatal(err)
	}
}

func clientBookmarks(t *testing.T, ctx context.Context) bookmarks.Store {
	t.Helper()
	return bookmarks.ReadStore(clientMetaOf(t, ctx))
}

func bookmarkTitles(s bookmarks.Store) []string {
	rtn := []string{}
	for _, r := range s.Records {
		rtn = append(rtn, r.Title)
	}
	return rtn
}

func record(id string, title string, places ...string) string {
	list := ""
	for i, p := range places {
		if i > 0 {
			list += ","
		}
		list += p
	}
	return fmt.Sprintf(`{"id": %q, "url": "https://%s.example.com/", "title": %q, "places": [%s]}`, id, id, title, list)
}

func place(level string, id string) string {
	return placeIn(level, id, "")
}

func placeIn(level string, id string, folder string) string {
	return fmt.Sprintf(`{"level": %q, "id": %q, "folder": %q}`, level, id, folder)
}

func TestRemovingAProjectDropsItsPlacesAndKeepsTheOthers(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s, %s, %s, %s], "folders": {%q: [{"id": "f", "name": "F"}], %q: [{"id": "g", "name": "G"}]}}`,
		record("desktop", "Desktop docs", place("project", wsId+"/p1")),
		record("both", "Site and app", place("project", wsId+"/p2"), place("app", "")),
		record("site", "Site only", place("project", wsId+"/p2")),
		record("other", "Same id elsewhere", place("project", "another-workspace/p2")),
		"project:"+wsId+"/p2", "project:another-workspace/p2"))
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	got := clientBookmarks(t, ctx)
	if want := []string{"Desktop docs", "Site and app", "Same id elsewhere"}; !reflect.DeepEqual(bookmarkTitles(got), want) {
		t.Fatalf("records %v, want %v: the removed project's records go, the others stay", bookmarkTitles(got), want)
	}
	if got.Records[1].Places[0].Level != bookmarks.LevelApp || len(got.Records[1].Places) != 1 {
		t.Errorf("a record that sits elsewhere too keeps those places: %+v", got.Records[1].Places)
	}
	if _, has := got.Folders["project:"+wsId+"/p2"]; has || len(got.Folders["project:another-workspace/p2"]) != 1 {
		t.Errorf("folders %+v", got.Folders)
	}
	// The next project added takes the id p2 again: it starts with no bookmark of the removed one.
	reused := bookmarks.VisibleFrom(got, bookmarks.Here{WorkspaceId: wsId, ProjectId: "p2"}, bookmarks.Names{})
	if len(reused) != 1 || reused[0].Title != "Site and app" || len(reused[0].Places) != 1 || reused[0].Places[0].Level != bookmarks.LevelApp {
		t.Errorf("a new project of that id sees %+v, only what sits in the app", reused)
	}
	if kept := bookmarks.VisibleFrom(got, bookmarks.Here{WorkspaceId: wsId, ProjectId: "p1"}, bookmarks.Names{}); len(kept) != 2 || kept[0].Title != "Desktop docs" || kept[1].Title != "Site and app" {
		t.Errorf("p1 sees %+v, its own record and the app's", kept)
	}
}

func TestRemovingTheLastProjectWithBookmarksDeletesTheKey(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s], "folders": {%q: [{"id": "f", "name": "F"}]}}`, record("site", "Site", place("project", wsId+"/p2")), "project:"+wsId+"/p2"))
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	if clientMetaOf(t, ctx).HasKey(molten.BookmarksMetaKey) {
		t.Fatal("no bookmark is left: the key goes")
	}
}

func TestRemovingAProjectWritesNothingWhenItHadNoBookmark(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s]}`, record("desktop", "Desktop docs", place("project", wsId+"/p1"))))
	client, _ := wstore.DBGetSingleton[*waveobj.Client](ctx)
	before := waveobj.GetVersion(client)
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	client, _ = wstore.DBGetSingleton[*waveobj.Client](ctx)
	if waveobj.GetVersion(client) != before {
		t.Error("the client was written though no bookmark sat in the removed project")
	}
}

func TestRemovingAProjectWorksWithoutAClient(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
}

func TestDeletingAWorkspaceDropsItsPlacesAndItsProjects(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s, %s, %s, %s], "folders": {%q: [{"id": "f", "name": "F"}], %q: [{"id": "g", "name": "G"}]}}`,
		record("ws", "Workspace only", place("workspace", wsId)),
		record("proj", "Project and app", place("project", wsId+"/p1"), place("app", "")),
		record("other", "Another workspace", place("workspace", "another-workspace"), place("project", "another-workspace/p1")),
		record("ctx", "Context", place("context", "workshop")),
		"workspace:"+wsId, "project:another-workspace/p1"))
	if _, _, err := DeleteWorkspace(ctx, wsId, false); err != nil {
		t.Fatal(err)
	}
	got := clientBookmarks(t, ctx)
	if want := []string{"Project and app", "Another workspace", "Context"}; !reflect.DeepEqual(bookmarkTitles(got), want) {
		t.Fatalf("records %v, want %v", bookmarkTitles(got), want)
	}
	if len(got.Records[0].Places) != 1 || got.Records[0].Places[0].Level != bookmarks.LevelApp {
		t.Errorf("places %+v", got.Records[0].Places)
	}
	if _, has := got.Folders["workspace:"+wsId]; has || len(got.Folders["project:another-workspace/p1"]) != 1 {
		t.Errorf("folders %+v", got.Folders)
	}
}

func TestDeletingAContextDropsItsPlaces(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	meta := twoContexts()
	setClientMeta(t, ctx, meta)
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s, %s, %s], "folders": {"context:b": [{"id": "f", "name": "F"}], "context:a": [{"id": "g", "name": "G"}]}}`,
		record("b", "Context b and app", place("context", "b"), place("app", "")),
		record("b2", "Context b only", place("context", "b")),
		record("a", "Context a", place("context", "a"))))
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Delete(contexts.DeleteRequest{Id: "b"})
	}); err != nil {
		t.Fatal(err)
	}
	got := clientBookmarks(t, ctx)
	if want := []string{"Context b and app", "Context a"}; !reflect.DeepEqual(bookmarkTitles(got), want) {
		t.Fatalf("records %v, want %v", bookmarkTitles(got), want)
	}
	if _, has := got.Folders["context:b"]; has || len(got.Folders["context:a"]) != 1 {
		t.Errorf("folders %+v", got.Folders)
	}
}

func TestChangingAContextKeepsItsBookmarks(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	setClientMeta(t, ctx, twoContexts())
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s]}`, record("b", "Context b", place("context", "b"))))
	name := "Renamed"
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Update(contexts.UpdateRequest{Id: "b", Name: &name})
	}); err != nil {
		t.Fatal(err)
	}
	if got := clientBookmarks(t, ctx); !reflect.DeepEqual(bookmarkTitles(got), []string{"Context b"}) {
		t.Fatalf("records %v", bookmarkTitles(got))
	}
}

func TestUndoingTheDeleteOfAWorkspaceGivesItsBookmarksBack(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	ws := makeUndoWorkspace(t, ctx)
	putClientBookmarks(t, ctx, fmt.Sprintf(`{"records": [%s, %s, %s], "folders": {%q: [{"id": "f", "name": "F"}]}}`,
		record("ws", "Workspace only", placeIn("workspace", ws.OID, "f")),
		record("proj", "Project and app", place("project", ws.OID+"/p1"), place("app", "")),
		record("other", "Another workspace", place("workspace", "another-workspace")),
		"workspace:"+ws.OID))
	undoId, err := CaptureWorkspaceUndo(ctx, ws.OID, WorkspaceUndoKindDelete, "win-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := DeleteWorkspace(ctx, ws.OID, true); err != nil {
		t.Fatal(err)
	}
	if gone := clientBookmarks(t, ctx); !reflect.DeepEqual(bookmarkTitles(gone), []string{"Project and app", "Another workspace"}) || len(gone.Records[0].Places) != 1 {
		t.Fatalf("the delete drops the workspace's places: %v", bookmarkTitles(gone))
	}
	if _, err := RestoreWorkspaceUndo(ctx, undoId); err != nil {
		t.Fatal(err)
	}
	got := clientBookmarks(t, ctx)
	titles := bookmarkTitles(got)
	slices.Sort(titles)
	if want := []string{"Another workspace", "Project and app", "Workspace only"}; !reflect.DeepEqual(titles, want) {
		t.Fatalf("after undo: %v, want %v", titles, want)
	}
	here := bookmarks.Here{WorkspaceId: ws.OID, ProjectId: "p1"}
	if visible := bookmarks.VisibleFrom(got, here, bookmarks.Names{}); len(visible) != 2 || visible[0].Title != "Project and app" || len(visible[0].Places) != 2 || visible[1].Title != "Workspace only" || visible[1].Places[0].Folder != "F" {
		t.Errorf("the restored workspace sees %+v", visible)
	}
}

const legacyP1 = `{"p1": {"folders": [{"id": "f1", "name": "Docs"}], "items": [{"id": "b1", "url": "https://vite.dev/config/", "title": "Vite config", "description": "Build options.", "folder": "f1"}]}}`

func setLegacyBookmarks(t *testing.T, ctx context.Context, wsId string, raw string) {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	ws.Meta[molten.BookmarksLegacyMetaKey] = value
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		t.Fatal(err)
	}
}

func TestMigratingMovesEachWorkspacesBookmarksToTheirProjectsPlaceOnce(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	a := makeProjectWorkspace(t, ctx, notuliaMeta())
	b := makeProjectWorkspace(t, ctx, notuliaMeta())
	c := makeProjectWorkspace(t, ctx, notuliaMeta())
	setLegacyBookmarks(t, ctx, a, legacyP1)
	setLegacyBookmarks(t, ctx, b, `{"p1": {"items": [{"id": "b1", "url": "https://b.example.com/", "title": "From b"}]}, "p2": {"items": [{"url": "https://p2.example.com/", "title": "B site"}]}}`)

	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{a, b, c} {
		if workspaceOf(t, ctx, id).Meta.HasKey(molten.BookmarksLegacyMetaKey) {
			t.Errorf("workspace %s kept the old key", id)
		}
	}
	got := clientBookmarks(t, ctx)
	if len(got.Records) != 3 {
		t.Fatalf("records %v", bookmarkTitles(got))
	}
	visible := bookmarks.VisibleFrom(got, bookmarks.Here{WorkspaceId: a, ProjectId: "p1"}, bookmarks.Names{})
	if len(visible) != 1 || visible[0].Title != "Vite config" || visible[0].Places[0].Folder != "Docs" || visible[0].Description != "Build options." {
		t.Errorf("a/p1 sees %+v", visible)
	}
	inB := bookmarks.VisibleFrom(got, bookmarks.Here{WorkspaceId: b, ProjectId: "p1"}, bookmarks.Names{})
	if len(inB) != 1 || inB[0].Title != "From b" {
		t.Errorf("b/p1 sees %+v: its project p1 is not a's", inB)
	}
	if none := bookmarks.VisibleFrom(got, bookmarks.Here{WorkspaceId: c, ProjectId: "p1"}, bookmarks.Names{}); len(none) != 0 {
		t.Errorf("c/p1 sees %+v", none)
	}
	ids := []string{}
	for _, r := range got.Records {
		ids = append(ids, r.Id)
	}
	slices.Sort(ids)
	if len(slices.Compact(slices.Clone(ids))) != 3 || !slices.Contains(ids, "b1") {
		t.Errorf("ids %v: the first b1 is kept, the second gets another", ids)
	}

	client, _ := wstore.DBGetSingleton[*waveobj.Client](ctx)
	version := waveobj.GetVersion(client)
	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	client, _ = wstore.DBGetSingleton[*waveobj.Client](ctx)
	if waveobj.GetVersion(client) != version {
		t.Error("a second start wrote the client again")
	}
}

// A start that follows a write that died between the store and the old keys finds the old key still there: nothing is
// added twice.
func TestMigratingAgainAfterAnInterruptedRunDoesNotDuplicate(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	a := makeProjectWorkspace(t, ctx, notuliaMeta())
	setLegacyBookmarks(t, ctx, a, legacyP1)
	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	setLegacyBookmarks(t, ctx, a, legacyP1)
	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	if got := clientBookmarks(t, ctx); len(got.Records) != 1 {
		t.Fatalf("records %v", bookmarkTitles(got))
	}
	if workspaceOf(t, ctx, a).Meta.HasKey(molten.BookmarksLegacyMetaKey) {
		t.Error("the old key stayed")
	}
}

func TestMigratingKeepsTheBookmarksTheWindowsAlreadyWrote(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	a := makeProjectWorkspace(t, ctx, notuliaMeta())
	putClientBookmarks(t, ctx, `{"records": [{"id": "b1", "url": "https://existing.example.com/", "title": "Existing", "places": [{"level": "app", "id": "", "folder": ""}]}]}`)
	setLegacyBookmarks(t, ctx, a, legacyP1)
	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	got := clientBookmarks(t, ctx)
	if len(got.Records) != 2 || got.Records[0].Title != "Existing" || got.Records[0].Id != "b1" || got.Records[1].Id == "b1" {
		t.Fatalf("records %+v", got.Records)
	}
}

func TestMigratingWithoutAClientLeavesTheOldKeysForTheNextStart(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	a := makeProjectWorkspace(t, ctx, notuliaMeta())
	setLegacyBookmarks(t, ctx, a, legacyP1)
	if err := MigrateBookmarks(ctx); err != nil {
		t.Fatal(err)
	}
	if !workspaceOf(t, ctx, a).Meta.HasKey(molten.BookmarksLegacyMetaKey) {
		t.Fatal("the bookmarks of a workspace were dropped with nowhere to go")
	}
}
