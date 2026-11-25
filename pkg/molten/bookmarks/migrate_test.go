// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func legacyMeta(t *testing.T, raw string) waveobj.MetaMapType {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return waveobj.MetaMapType{molten.BookmarksLegacyMetaKey: value}
}

// What an earlier version kept in a workspace's meta: {projectId: {folders, items}}.
const legacyTwoProjects = `{
  "p1": {
    "folders": [{"id": "f1", "name": "Docs"}, {"id": "f2", "name": "Ops"}],
    "items": [
      {"id": "b1", "url": "https://vite.dev/config/", "title": "Vite config", "description": "The build options.", "folder": "f1"},
      {"id": "b2", "url": "https://staging.example.com/", "title": "Staging", "description": "", "folder": ""},
      {"id": "b3", "url": "https://example.com/lost", "title": "Lost folder", "folder": "f-removed"},
      {"id": "b4", "url": "javascript:alert(1)", "title": "Script"}
    ]
  },
  "p2": {"items": [{"id": "b5", "url": "https://site.example.com/", "title": "Site", "description": "The marketing site."}]}
}`

func TestMigrateMakesOneRecordPerItemAtItsProjectKeepingIdFolderAndNote(t *testing.T) {
	t.Parallel()
	got, cleared := Migrate(Store{}, []WorkspaceMeta{{Id: "ws-a", Meta: legacyMeta(t, legacyTwoProjects)}})
	if !reflect.DeepEqual(cleared, []string{"ws-a"}) {
		t.Fatalf("cleared %v", cleared)
	}
	if want := []string{"b1", "b2", "b3", "b5"}; !reflect.DeepEqual(recordIds(got), want) {
		t.Fatalf("records %v, want %v (the script address is not a bookmark)", recordIds(got), want)
	}
	first := got.Records[0]
	if first.Title != "Vite config" || first.Description != "The build options." || first.Url != "https://vite.dev/config/" ||
		!reflect.DeepEqual(first.Places, []Place{{Level: LevelProject, Id: "ws-a/p1", Folder: "f1"}}) {
		t.Errorf("first %+v", first)
	}
	if lost := got.Records[2]; !reflect.DeepEqual(lost.Places, []Place{{Level: LevelProject, Id: "ws-a/p1"}}) {
		t.Errorf("a folder the project lacks reads as directly in the project: %+v", lost)
	}
	if site := got.Records[3]; !reflect.DeepEqual(site.Places, []Place{{Level: LevelProject, Id: "ws-a/p2"}}) {
		t.Errorf("site %+v", site)
	}
	if want := map[string][]Folder{"project:ws-a/p1": {{Id: "f1", Name: "Docs"}, {Id: "f2", Name: "Ops"}}}; !reflect.DeepEqual(got.Folders, want) {
		t.Errorf("folders %+v, want %+v", got.Folders, want)
	}
	inP1 := titles(VisibleFrom(got, Here{WorkspaceId: "ws-a", ProjectId: "p1"}, Names{}))
	if want := []string{"Staging", "Lost folder", "Vite config"}; !reflect.DeepEqual(inP1, want) {
		t.Errorf("the migrated bookmarks of p1 read as %v, want %v", inP1, want)
	}
}

// Project ids repeat from workspace to workspace, and so can the ids of the items an earlier version made.
func TestMigrateKeepsTwoWorkspacesThatBothHaveProjectP1Apart(t *testing.T) {
	t.Parallel()
	a := legacyMeta(t, `{"p1": {"folders": [{"id": "f1", "name": "A docs"}], "items": [{"id": "b1", "url": "https://a.example.com/", "title": "From A", "folder": "f1"}]}}`)
	b := legacyMeta(t, `{"p1": {"folders": [{"id": "f1", "name": "B docs"}], "items": [{"id": "b1", "url": "https://b.example.com/", "title": "From B", "folder": "f1"}]}}`)
	got, cleared := Migrate(Store{}, []WorkspaceMeta{{Id: "ws-b", Meta: b}, {Id: "ws-a", Meta: a}})
	if !reflect.DeepEqual(cleared, []string{"ws-a", "ws-b"}) {
		t.Fatalf("cleared %v", cleared)
	}
	if len(got.Records) != 2 || got.Records[0].Id != "b1" || got.Records[1].Id == "b1" || got.Records[1].Id == "" || !strings.HasPrefix(got.Records[1].Id, "b-") {
		t.Fatalf("the second item of id b1 gets a new id, the first keeps it (workspaces in order of id): %+v", got.Records)
	}
	for _, c := range []struct{ ws, title, folder string }{{"ws-a", "From A", "A docs"}, {"ws-b", "From B", "B docs"}} {
		visible := VisibleFrom(got, Here{WorkspaceId: c.ws, ProjectId: "p1"}, Names{})
		if len(visible) != 1 || visible[0].Title != c.title || visible[0].Places[0].Folder != c.folder {
			t.Errorf("%s/p1 sees %+v, want only %q in folder %q", c.ws, visible, c.title, c.folder)
		}
	}
}

func TestMigrateMakesANewIdWhenAnotherRecordHasIt(t *testing.T) {
	t.Parallel()
	existing := Store{Records: []Record{{Id: "b1", Url: "https://existing.example.com/", Title: "Existing", Places: []Place{{Level: LevelApp}}}}}
	legacy := legacyMeta(t, `{"p1": {"items": [{"id": "b1", "url": "https://legacy.example.com/", "title": "Legacy"}, {"url": "https://noid.example.com/", "title": "No id"}, {"id": "b-new", "url": "https://kept.example.com/", "title": "Kept id"}]}}`)
	got, _ := Migrate(existing, []WorkspaceMeta{{Id: "ws", Meta: legacy}})
	if len(got.Records) != 4 || got.Records[0].Title != "Existing" || got.Records[0].Id != "b1" {
		t.Fatalf("%+v", got.Records)
	}
	seen := map[string]bool{}
	for _, r := range got.Records {
		if r.Id == "" || seen[r.Id] {
			t.Errorf("record %q has an empty or a repeated id: %v", r.Title, recordIds(got))
		}
		seen[r.Id] = true
	}
	if got.Records[1].Id == "b1" || got.Records[2].Id == "" || got.Records[3].Id != "b-new" {
		t.Errorf("ids %v: the colliding id is made again, an item without one gets one, any other is kept", recordIds(got))
	}
	if len(existing.Records) != 1 {
		t.Error("the store it was given was changed")
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	t.Parallel()
	workspaces := []WorkspaceMeta{{Id: "ws-a", Meta: legacyMeta(t, legacyTwoProjects)}}
	once, cleared := Migrate(Store{}, workspaces)
	again, clearedAgain := Migrate(once, workspaces)
	if !reflect.DeepEqual(again, once) {
		t.Fatalf("a crash that left the old key in place must not duplicate the records:\n%+v\n%+v", again.Records, once.Records)
	}
	if !reflect.DeepEqual(cleared, clearedAgain) {
		t.Errorf("the old key is still cleared: %v %v", cleared, clearedAgain)
	}
	// Once the old keys are gone, there is nothing to move.
	none, clearedNone := Migrate(once, []WorkspaceMeta{{Id: "ws-a", Meta: waveobj.MetaMapType{"molten:project": "/x"}}, {Id: "ws-b"}})
	if len(clearedNone) != 0 || !reflect.DeepEqual(none, once) {
		t.Errorf("a second run moved %v", clearedNone)
	}
}

func TestMigrateClearsEveryLegacyKeyWhateverItHolds(t *testing.T) {
	t.Parallel()
	got, cleared := Migrate(Store{}, []WorkspaceMeta{
		{Id: "ws-empty", Meta: legacyMeta(t, `{}`)},
		{Id: "ws-string", Meta: legacyMeta(t, `"oops"`)},
		{Id: "ws-null", Meta: waveobj.MetaMapType{molten.BookmarksLegacyMetaKey: nil}},
		{Id: "ws-badproject", Meta: legacyMeta(t, `{"p1": "oops", "": {"items": [{"id": "x", "url": "https://x.example.com/"}]}, "a/b": {"items": [{"id": "y", "url": "https://y.example.com/"}]}}`)},
		{Id: "ws-none", Meta: waveobj.MetaMapType{"molten:project": "/x"}},
	})
	if want := []string{"ws-badproject", "ws-empty", "ws-null", "ws-string"}; !reflect.DeepEqual(cleared, want) {
		t.Fatalf("cleared %v, want %v", cleared, want)
	}
	if len(got.Records) != 0 {
		t.Errorf("records %+v", got.Records)
	}
}

func TestMigrateAppliesTheLimitsOfReading(t *testing.T) {
	t.Parallel()
	var folders, items []any
	for i := 0; i < maxFolders+10; i++ {
		folders = append(folders, map[string]any{"id": fmt.Sprintf("f%d", i), "name": fmt.Sprintf("Folder %d", i)})
	}
	for i := 0; i < maxBookmarks+40; i++ {
		items = append(items, map[string]any{"id": fmt.Sprintf("b%d", i), "url": fmt.Sprintf("https://example.com/%d", i), "title": fmt.Sprintf("Page %d", i), "folder": "f0"})
	}
	items[0] = map[string]any{
		"id": "b0", "url": "https://example.com/0", "folder": fmt.Sprintf("f%d", maxFolders+5),
		"title": strings.Repeat("t", maxTitle+100), "description": strings.Repeat("d", maxDescription+100),
	}
	items[1] = map[string]any{"id": "b1", "url": "https://example.com/" + strings.Repeat("a", maxAddress), "title": "Too long"}
	items[2] = map[string]any{"id": "b2", "url": "https://example.com/2", "title": "Control\u001b[31m chars\u0007"}
	meta := waveobj.MetaMapType{molten.BookmarksLegacyMetaKey: map[string]any{"p1": map[string]any{"folders": folders, "items": items}}}
	got, _ := Migrate(Store{}, []WorkspaceMeta{{Id: "ws", Meta: meta}})
	if len(got.Records) != maxBookmarks {
		t.Fatalf("%d records, want %d", len(got.Records), maxBookmarks)
	}
	if len(got.Folders["project:ws/p1"]) != maxFolders {
		t.Errorf("%d folders, want %d", len(got.Folders["project:ws/p1"]), maxFolders)
	}
	first := got.Records[0]
	if len([]rune(first.Title)) != maxTitle || len([]rune(first.Description)) != maxDescription || first.Places[0].Folder != "" {
		t.Errorf("first: title %d, description %d, folder %q (a folder past the limit is not one)", len(first.Title), len(first.Description), first.Places[0].Folder)
	}
	for _, r := range got.Records {
		if r.Title == "Too long" {
			t.Errorf("an address over the limit was moved: %+v", r)
		}
	}
	if got.Records[1].Title != "Control[31m chars" {
		t.Errorf("control characters stay: %q", got.Records[1].Title)
	}
	again := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: got.MetaValue()})
	if !reflect.DeepEqual(recordIds(again), recordIds(got)) {
		t.Error("what the migration wrote reads back as written")
	}
}

func TestMigrateStopsAtTheLimitOfRecords(t *testing.T) {
	t.Parallel()
	var workspaces []WorkspaceMeta
	for w := 0; w < 11; w++ {
		var items []any
		for i := 0; i < maxBookmarks; i++ {
			items = append(items, map[string]any{"id": fmt.Sprintf("b%d", i), "url": fmt.Sprintf("https://example.com/%d/%d", w, i)})
		}
		workspaces = append(workspaces, WorkspaceMeta{Id: fmt.Sprintf("w%02d", w), Meta: waveobj.MetaMapType{molten.BookmarksLegacyMetaKey: map[string]any{"p1": map[string]any{"items": items}}}})
	}
	got, cleared := Migrate(Store{}, workspaces)
	if len(got.Records) != maxRecords || len(cleared) != 11 {
		t.Fatalf("%d records, %d cleared", len(got.Records), len(cleared))
	}
	ids := recordIds(got)
	slices.Sort(ids)
	if len(slices.Compact(ids)) != maxRecords {
		t.Error("an id is repeated")
	}
}
