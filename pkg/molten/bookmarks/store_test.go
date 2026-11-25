// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func recordIds(s Store) []string {
	rtn := []string{}
	for _, r := range s.Records {
		rtn = append(rtn, r.Id)
	}
	return rtn
}

func appPlace() map[string]any {
	return map[string]any{"level": "app", "id": "", "folder": ""}
}

func TestReadStoreKeepsTheFixtureAsWritten(t *testing.T) {
	t.Parallel()
	s := fixture(t)
	if want := []string{"b-1", "b-2", "b-3", "b-4", "b-5", "b-6", "b-7"}; !reflect.DeepEqual(recordIds(s), want) {
		t.Fatalf("records %v, want %v", recordIds(s), want)
	}
	if got := s.Records[0].Places; !reflect.DeepEqual(got, []Place{{Level: "project", Id: "ws-a/p1", Folder: "f-docs"}, {Level: "app"}}) {
		t.Fatalf("places %+v", got)
	}
	if got := s.Folders["project:ws-a/p1"]; !reflect.DeepEqual(got, []Folder{{Id: "f-docs", Name: "Docs"}, {Id: "f-api", Name: "API"}}) {
		t.Fatalf("folders %+v", got)
	}
}

// What is written back after a cleanup must be what the developer kept: the address is cleaned for an agent in
// VisibleFrom, never in the store.
func TestReadStoreKeepsAddressesAsStored(t *testing.T) {
	t.Parallel()
	s := ReadStore(clientMeta(t, `{"records": [{"id": "a", "url": " https://grafana.example.com/d/abc?token=SECRET&orgId=1#panel ", "title": "T", "places": [{"level": "app"}]}]}`))
	if len(s.Records) != 1 || s.Records[0].Url != "https://grafana.example.com/d/abc?token=SECRET&orgId=1#panel" {
		t.Fatalf("%+v", s.Records)
	}
}

func TestReadStoreDropsWhatIsNotAValidRecord(t *testing.T) {
	t.Parallel()
	good := map[string]any{"id": "ok", "url": "https://ok.example.com/", "title": "Ok", "places": []any{appPlace()}}
	records := []any{
		good,
		map[string]any{"id": "js", "url": "javascript:alert(document.cookie)", "places": []any{appPlace()}},
		map[string]any{"id": "file", "url": "file:///etc/passwd", "places": []any{appPlace()}},
		map[string]any{"id": "data", "url": "data:text/html,<b>x</b>", "places": []any{appPlace()}},
		map[string]any{"id": "ftp", "url": "ftp://example.com/", "places": []any{appPlace()}},
		map[string]any{"id": "nohost", "url": "https:///nohost", "places": []any{appPlace()}},
		map[string]any{"id": "words", "url": "not an address", "places": []any{appPlace()}},
		map[string]any{"id": "long", "url": "https://example.com/" + strings.Repeat("a", maxAddress), "places": []any{appPlace()}},
		map[string]any{"id": "", "url": "https://noid.example.com/", "places": []any{appPlace()}},
		map[string]any{"url": "https://noid2.example.com/", "places": []any{appPlace()}},
		map[string]any{"id": "ok", "url": "https://dup.example.com/", "title": "Duplicate id", "places": []any{appPlace()}},
		map[string]any{"id": "noplace", "url": "https://noplace.example.com/"},
		map[string]any{"id": "emptyplaces", "url": "https://noplace.example.com/", "places": []any{}},
		map[string]any{"id": "unknownlevel", "url": "https://x.example.com/", "places": []any{map[string]any{"level": "galaxy", "id": "x"}}},
		map[string]any{"id": "nolevel", "url": "https://x.example.com/", "places": []any{map[string]any{"id": "x"}}},
		map[string]any{"id": "noctxid", "url": "https://x.example.com/", "places": []any{map[string]any{"level": "context", "id": ""}}},
		map[string]any{"id": "nowsid", "url": "https://x.example.com/", "places": []any{map[string]any{"level": "workspace"}}},
		map[string]any{"id": "noprojectslash", "url": "https://x.example.com/", "places": []any{map[string]any{"level": "project", "id": "p1"}}},
		map[string]any{"id": "noprojectid", "url": "https://x.example.com/", "places": []any{map[string]any{"level": "project", "id": "ws/"}}},
		"oops", 4, nil, []any{},
	}
	meta := waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{"records": records}}
	got := ReadStore(meta)
	if want := []string{"ok"}; !reflect.DeepEqual(recordIds(got), want) || got.Records[0].Title != "Ok" {
		t.Fatalf("records %+v, want only the first one named ok (the first record of an id wins)", got.Records)
	}
}

func TestReadStoreDropsTheSecondPlaceOfARecordAtTheSameLevelAndId(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"records": [{"id": "a", "url": "https://a.example.com/", "places": [
	  {"level": "workspace", "id": "w", "folder": "f"}, {"level": "workspace", "id": "w", "folder": ""}, {"level": "workspace", "id": "w2"},
	  {"level": "app", "id": "ignored"}, {"level": "app"}, {"level": "galaxy", "id": "x"}
	]}], "folders": {"workspace:w": [{"id": "f", "name": "F"}]}}`)
	got := ReadStore(meta).Records[0].Places
	want := []Place{{Level: "workspace", Id: "w", Folder: "f"}, {Level: "workspace", Id: "w2"}, {Level: "app"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("places %+v, want %+v", got, want)
	}
}

// A folder belongs to one place: a record at another place cannot name it.
func TestReadStoreReadsAFolderOfAnotherPlaceAsDirectlyInThePlace(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"records": [
	  {"id": "a", "url": "https://a.example.com/", "places": [{"level": "workspace", "id": "w1", "folder": "f-of-w2"}, {"level": "workspace", "id": "w2", "folder": "f-of-w2"}, {"level": "workspace", "id": "w3", "folder": "f-gone"}]}
	], "folders": {"workspace:w2": [{"id": "f-of-w2", "name": "W2 folder"}]}}`)
	got := ReadStore(meta).Records[0].Places
	want := []Place{{Level: "workspace", Id: "w1"}, {Level: "workspace", Id: "w2", Folder: "f-of-w2"}, {Level: "workspace", Id: "w3"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("places %+v, want %+v", got, want)
	}
	visible := VisibleFrom(ReadStore(meta), Here{WorkspaceId: "w1"}, Names{})
	if len(visible) != 1 || visible[0].Places[0].Folder != "" {
		t.Fatalf("w1 learned the folder of w2: %+v", visible)
	}
}

func TestReadStoreReadsFoldersOfValidPlacesOnly(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"folders": {
	  "app": [{"id": "fa", "name": "App folder"}, {"id": "fa", "name": "Same id"}, {"id": "", "name": "No id"}, {"id": "fb", "name": ""}],
	  "context:c": [{"id": "fc", "name": "C"}],
	  "workspace:": [{"id": "x", "name": "No workspace"}],
	  "project:w": [{"id": "x", "name": "No project id"}],
	  "galaxy:g": [{"id": "x", "name": "Unknown level"}],
	  "app:x": [{"id": "x", "name": "App has no id"}],
	  "context:empty": "oops"
	}}`)
	got := ReadStore(meta).Folders
	want := map[string][]Folder{"app": {{Id: "fa", Name: "App folder"}}, "context:c": {{Id: "fc", Name: "C"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("folders %+v, want %+v", got, want)
	}
}

func TestReadStoreSurvivesMalformedValues(t *testing.T) {
	t.Parallel()
	for _, value := range []any{"oops", 4, nil, []any{"a"}, map[string]any{"records": "x", "folders": []any{1}}, map[string]any{"records": []any{1, "a", nil, map[string]any{"url": 4}}}} {
		got := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: value})
		if len(got.Records) != 0 || len(got.Folders) != 0 {
			t.Errorf("%v: %+v", value, got)
		}
	}
	if got := ReadStore(nil); len(got.Records) != 0 {
		t.Errorf("no meta: %+v", got)
	}
}

func TestReadStoreCutsWhatIsReadToTheTextLimits(t *testing.T) {
	t.Parallel()
	record := map[string]any{
		"id": "a", "url": "https://example.com/0", "title": strings.Repeat("t", maxTitle+100), "description": strings.Repeat("d", maxDescription+100),
		"places": []any{map[string]any{"level": "workspace", "id": "w", "folder": "f"}},
	}
	meta := waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{
		"records": []any{record},
		"folders": map[string]any{"workspace:w": []any{map[string]any{"id": "f", "name": strings.Repeat("n", maxFolderName+30)}}},
	}}
	got := ReadStore(meta)
	r := got.Records[0]
	if len([]rune(r.Title)) != maxTitle || len([]rune(r.Description)) != maxDescription || len([]rune(got.Folders["workspace:w"][0].Name)) != maxFolderName {
		t.Errorf("texts cut: title %d, description %d, folder %d", len(r.Title), len(r.Description), len(got.Folders["workspace:w"][0].Name))
	}
}

func TestReadStoreGivesAPlaceItsFirstBookmarksInRecordOrder(t *testing.T) {
	t.Parallel()
	var records []any
	for i := 0; i < maxBookmarks+40; i++ {
		places := []any{map[string]any{"level": "workspace", "id": "w"}}
		if i%100 == 0 {
			places = append(places, map[string]any{"level": "app"})
		}
		records = append(records, map[string]any{"id": fmt.Sprintf("b%d", i), "url": fmt.Sprintf("https://example.com/%d", i), "places": places})
	}
	got := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{"records": records}})
	inW, inApp := 0, 0
	for _, r := range got.Records {
		for _, p := range r.Places {
			switch p.Level {
			case LevelWorkspace:
				inW++
			case LevelApp:
				inApp++
			}
		}
	}
	if inW != maxBookmarks {
		t.Errorf("%d bookmarks in the workspace, want %d", inW, maxBookmarks)
	}
	// b300 sits in the full workspace and in the app: it stays for the app, only its workspace place goes; the ones after
	// it, which sit nowhere else, go.
	if inApp != 4 || len(got.Records) != maxBookmarks+1 {
		t.Errorf("%d in the app and %d records, want 4 and %d", inApp, len(got.Records), maxBookmarks+1)
	}
	if last := got.Records[len(got.Records)-1]; last.Id != "b300" || len(last.Places) != 1 || last.Places[0].Level != LevelApp {
		t.Errorf("last record %+v", last)
	}
	if first := got.Records[0]; first.Id != "b0" || len(first.Places) != 2 {
		t.Errorf("first record %+v", first)
	}
}

func TestReadStoreHoldsAtMostThousandsOfRecordsPlacesAndFolders(t *testing.T) {
	t.Parallel()
	var records []any
	for i := 0; i < maxRecords+50; i++ {
		records = append(records, map[string]any{"id": fmt.Sprintf("b%d", i), "url": fmt.Sprintf("https://example.com/%d", i), "places": []any{map[string]any{"level": "workspace", "id": fmt.Sprintf("w%d", i)}}})
	}
	var places []any
	for i := 0; i < maxPlaces+10; i++ {
		places = append(places, map[string]any{"level": "workspace", "id": fmt.Sprintf("many%d", i)})
	}
	var folders []any
	for i := 0; i < maxFolders+10; i++ {
		folders = append(folders, map[string]any{"id": fmt.Sprintf("f%d", i), "name": fmt.Sprintf("Folder %d", i)})
	}
	got := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{"records": records, "folders": map[string]any{"app": folders}}})
	if len(got.Records) != maxRecords || got.Records[maxRecords-1].Id != fmt.Sprintf("b%d", maxRecords-1) {
		t.Errorf("%d records, want %d", len(got.Records), maxRecords)
	}
	if len(got.Folders["app"]) != maxFolders {
		t.Errorf("%d folders, want %d", len(got.Folders["app"]), maxFolders)
	}
	wide := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{"records": []any{map[string]any{"id": "a", "url": "https://a.example.com/", "places": places}}}})
	if len(wide.Records[0].Places) != maxPlaces {
		t.Errorf("%d places, want %d", len(wide.Records[0].Places), maxPlaces)
	}
}

func TestMetaValueRoundTrips(t *testing.T) {
	t.Parallel()
	s := fixture(t)
	again := ReadStore(waveobj.MetaMapType{molten.BookmarksMetaKey: s.MetaValue()})
	if !reflect.DeepEqual(again, s) {
		t.Fatalf("round trip:\n%+v\n%+v", again, s)
	}
	if (Store{}).MetaValue() != nil || (Store{Folders: map[string][]Folder{"app": nil}}).MetaValue() != nil {
		t.Error("an empty store is no value: the key goes")
	}
	onlyFolders := Store{Folders: map[string][]Folder{"app": {{Id: "f", Name: "F"}}}}
	if onlyFolders.MetaValue() == nil {
		t.Error("a folder with no bookmark is kept")
	}
}
