// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The client's meta as the database hands it over after a round trip through JSON. The developer works in the
// workspace ws-a (projects p1 Desktop and p2 Website) of the context ctx-client; ws-b is another workspace that also has
// a project p1; ctx-perso is another context. Every place has bookmarks the others must not see.
const fixtureStore = `{
  "records": [
    {"id": "b-1", "url": "https://vite.dev/config/", "title": "Vite config", "description": "The build options the renderer relies on.",
     "places": [{"level": "project", "id": "ws-a/p1", "folder": "f-docs"}, {"level": "app", "id": "", "folder": ""}]},
    {"id": "b-2", "url": "https://staging.example.com/", "title": "Staging", "description": "",
     "places": [{"level": "project", "id": "ws-a/p1", "folder": ""}, {"level": "context", "id": "ctx-client", "folder": "f-ops"}]},
    {"id": "b-3", "url": "https://grafana.example.com/d/abc?token=SECRET&orgId=1", "title": "Dashboards", "description": "Latency and errors.",
     "places": [{"level": "workspace", "id": "ws-a", "folder": "f-shared"}]},
    {"id": "b-4", "url": "https://other-workspace.example.com/", "title": "Other workspace's p1", "description": "",
     "places": [{"level": "project", "id": "ws-b/p1", "folder": "f-secret-project"}]},
    {"id": "b-5", "url": "https://personal.example.com/", "title": "Personal", "description": "",
     "places": [{"level": "context", "id": "ctx-perso", "folder": "f-secret-context"}]},
    {"id": "b-6", "url": "https://site.example.com/", "title": "Site", "description": "The marketing site.",
     "places": [{"level": "project", "id": "ws-a/p2", "folder": ""}]},
    {"id": "b-7", "url": "https://everywhere.example.com/", "title": "Everywhere", "description": "",
     "places": [{"level": "context", "id": "ctx-perso", "folder": ""}, {"level": "app", "id": "", "folder": ""}, {"level": "project", "id": "ws-b/p1", "folder": ""}]}
  ],
  "folders": {
    "project:ws-a/p1": [{"id": "f-docs", "name": "Docs"}, {"id": "f-api", "name": "API"}],
    "context:ctx-client": [{"id": "f-ops", "name": "Ops"}],
    "workspace:ws-a": [{"id": "f-shared", "name": "Shared"}],
    "project:ws-b/p1": [{"id": "f-secret-project", "name": "Secret project folder"}],
    "context:ctx-perso": [{"id": "f-secret-context", "name": "Secret context folder"}]
  }
}`

var (
	hereInP1 = Here{ContextId: "ctx-client", WorkspaceId: "ws-a", ProjectId: "p1"}
	namesOfA = Names{Context: "Client SEFERS", Workspace: "Acme", Project: "Desktop"}
)

func clientMeta(t *testing.T, store string) waveobj.MetaMapType {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(store), &value); err != nil {
		t.Fatal(err)
	}
	return waveobj.MetaMapType{molten.BookmarksMetaKey: value}
}

func fixture(t *testing.T) Store {
	t.Helper()
	return ReadStore(clientMeta(t, fixtureStore))
}

func titles(list []molten.Bookmark) []string {
	rtn := []string{}
	for _, b := range list {
		rtn = append(rtn, b.Title)
	}
	return rtn
}

// shapes lists each bookmark as "Title @ level:name:folder, level:name:folder" for a compact comparison.
func shapes(list []molten.Bookmark) []string {
	rtn := []string{}
	for _, b := range list {
		places := []string{}
		for _, p := range b.Places {
			places = append(places, fmt.Sprintf("%s:%s:%s", p.Level, p.Name, p.Folder))
		}
		rtn = append(rtn, b.Title+" @ "+strings.Join(places, ", "))
	}
	return rtn
}

func TestVisibleFromGivesWhatTheTerminalsPlaceSeesOnceEach(t *testing.T) {
	t.Parallel()
	got := shapes(VisibleFrom(fixture(t), hereInP1, namesOfA))
	want := []string{
		"Staging @ project:Desktop:, context:Client SEFERS:Ops",
		"Vite config @ project:Desktop:Docs, app::",
		"Dashboards @ workspace:Acme:Shared",
		"Everywhere @ app::",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Project ids repeat from workspace to workspace: p1 of ws-b is not p1 of ws-a.
func TestVisibleFromSeparatesTheProjectsOfTwoWorkspacesThatShareAProjectId(t *testing.T) {
	t.Parallel()
	inB := Here{ContextId: "ctx-client", WorkspaceId: "ws-b", ProjectId: "p1"}
	got := titles(VisibleFrom(fixture(t), inB, Names{Workspace: "Beta", Project: "Desktop"}))
	if want := []string{"Everywhere", "Other workspace's p1", "Staging", "Vite config"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ws-b/p1 sees %v, want %v: not ws-a/p1's own bookmarks, which only the context's and the app's places share", got, want)
	}
	inP2 := Here{ContextId: "ctx-client", WorkspaceId: "ws-a", ProjectId: "p2"}
	got = titles(VisibleFrom(fixture(t), inP2, Names{Project: "Website"}))
	if want := []string{"Site", "Dashboards", "Staging", "Vite config", "Everywhere"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ws-a/p2 sees %v, want %v: the workspace's, the context's and the app's bookmarks are shared by its projects", got, want)
	}
}

func TestVisibleFromHidesAnotherContext(t *testing.T) {
	t.Parallel()
	inPerso := Here{ContextId: "ctx-perso", WorkspaceId: "ws-c"}
	got := shapes(VisibleFrom(fixture(t), inPerso, Names{Context: "Personal", Workspace: "Home"}))
	want := []string{"Everywhere @ context:Personal:, app::", "Personal @ context:Personal:Secret context folder", "Vite config @ app::"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// An agent never learns the name of a place it is not in, nor a folder there, nor that a record sits there.
func TestVisibleFromNeverNamesAPlaceTheTerminalIsNotIn(t *testing.T) {
	t.Parallel()
	data, err := json.Marshal(VisibleFrom(fixture(t), hereInP1, namesOfA))
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"ctx-perso", "ws-b", "Secret", "Personal", "other-workspace", "p2", "Website", "f-docs", "f-ops"} {
		if strings.Contains(string(data), leak) {
			t.Errorf("%q reached the terminal: %s", leak, data)
		}
	}
}

func TestVisibleFromWithoutAProjectListsTheWorkspaceTheContextAndTheApp(t *testing.T) {
	t.Parallel()
	got := shapes(VisibleFrom(fixture(t), Here{ContextId: "ctx-client", WorkspaceId: "ws-a"}, Names{Context: "Client SEFERS", Workspace: "Acme"}))
	want := []string{
		"Dashboards @ workspace:Acme:Shared",
		"Staging @ context:Client SEFERS:Ops",
		"Vite config @ app::",
		"Everywhere @ app::",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestVisibleFromNamesAPlaceByItsIdWhenItHasNoName(t *testing.T) {
	t.Parallel()
	got := shapes(VisibleFrom(fixture(t), hereInP1, Names{}))
	if want := "Staging @ project:p1:, context:ctx-client:Ops"; got[0] != want {
		t.Errorf("got %q, want %q", got[0], want)
	}
	if want := "Dashboards @ workspace:ws-a:Shared"; got[2] != want {
		t.Errorf("got %q, want %q", got[2], want)
	}
}

// Most specific place first; in a place, the bookmarks directly in it, then folder by folder in the folders' order, then
// in record order.
func TestVisibleFromOrdersByPlaceThenFolderThenRecord(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{
	  "records": [
	    {"id": "r1", "url": "https://a.example.com/", "title": "r1 in B", "places": [{"level": "workspace", "id": "w", "folder": "fb"}]},
	    {"id": "r2", "url": "https://b.example.com/", "title": "r2 loose", "places": [{"level": "workspace", "id": "w", "folder": ""}]},
	    {"id": "r3", "url": "https://c.example.com/", "title": "r3 in A", "places": [{"level": "workspace", "id": "w", "folder": "fa"}]},
	    {"id": "r4", "url": "https://d.example.com/", "title": "r4 in B", "places": [{"level": "workspace", "id": "w", "folder": "fb"}]},
	    {"id": "r5", "url": "https://e.example.com/", "title": "r5 loose", "places": [{"level": "workspace", "id": "w", "folder": ""}]},
	    {"id": "r6", "url": "https://f.example.com/", "title": "r6 app", "places": [{"level": "app", "id": "", "folder": ""}]},
	    {"id": "r7", "url": "https://g.example.com/", "title": "r7 context", "places": [{"level": "context", "id": "c", "folder": ""}]},
	    {"id": "r8", "url": "https://h.example.com/", "title": "r8 project", "places": [{"level": "project", "id": "w/p1", "folder": ""}, {"level": "app", "id": "", "folder": ""}]}
	  ],
	  "folders": {"workspace:w": [{"id": "fa", "name": "A"}, {"id": "fb", "name": "B"}]}
	}`)
	got := titles(VisibleFrom(ReadStore(meta), Here{ContextId: "c", WorkspaceId: "w", ProjectId: "p1"}, Names{}))
	want := []string{"r8 project", "r2 loose", "r5 loose", "r3 in A", "r1 in B", "r4 in B", "r7 context", "r6 app"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestVisibleFromNeverGivesAnAgentACredential(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"records": [
	  {"id": "a", "url": "https://user:pass@example.com/page?token=abc&page=2", "title": "With userinfo", "places": [{"level": "app"}]},
	  {"id": "b", "url": "https://bucket.example.com/f?X-Amz-Signature=abc&X-Amz-Expires=60", "title": "Signed", "description": "Keep for the report.", "places": [{"level": "app"}]},
	  {"id": "c", "url": "https://app.example.com/callback#access_token=abc123&state=xyz", "title": "OAuth return", "places": [{"level": "app"}]},
	  {"id": "d", "url": "https://shop.example.com/reset#9f8e7d6c5b4a", "title": "Reset link", "places": [{"level": "app"}]},
	  {"id": "e", "url": "https://docs.example.com/guide#install", "title": "Anchor", "places": [{"level": "app"}]}
	]}`)
	got := VisibleFrom(ReadStore(meta), Here{}, Names{})
	if len(got) != 5 {
		t.Fatalf("%+v", got)
	}
	if got[0].Url != "https://example.com/page?page=2" || got[0].Withheld {
		t.Errorf("userinfo and token not dropped: %+v", got[0])
	}
	if !got[1].Withheld || got[1].Url != "" || got[1].Title != "Signed" || got[1].Description != "Keep for the report." {
		t.Errorf("a signed address is withheld, its note stays: %+v", got[1])
	}
	// What follows the # is never read by the server, but an OAuth redirect or a reset link carries its secret there.
	for i, want := range map[int]string{2: "https://app.example.com/callback", 3: "https://shop.example.com/reset", 4: "https://docs.example.com/guide"} {
		if got[i].Url != want || got[i].Withheld {
			t.Errorf("the fragment of %q reached an agent: %+v", want, got[i])
		}
	}
}

func TestVisibleFromNamesAnUntitledBookmarkByItsAddressOrItsHost(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"records": [
	  {"id": "a", "url": "https://a.example.com", "places": [{"level": "app"}]},
	  {"id": "b", "url": "https://bucket.example.com/f?X-Amz-Signature=abc&X-Amz-Expires=60", "places": [{"level": "app"}]}
	]}`)
	got := VisibleFrom(ReadStore(meta), Here{}, Names{})
	if len(got) != 2 || got[0].Title != "https://a.example.com" || !got[1].Withheld || got[1].Title != "bucket.example.com" {
		t.Fatalf("an untitled bookmark is named by its address, or by its host when the address is withheld: %+v", got)
	}
}

func TestVisibleFromRemovesControlCharactersFromTheTexts(t *testing.T) {
	t.Parallel()
	meta := clientMeta(t, `{"records": [
	  {"id": "a", "url": "https://example.com/", "title": "Docs\u001b]0;pwned\u0007 now", "description": "Line one\nline\ttwo\u001b[2J\u0000end",
	   "places": [{"level": "workspace", "id": "w", "folder": "f"}]}
	], "folders": {"workspace:w": [{"id": "f", "name": "Ops\u001b[31m\nteam"}]}}`)
	got := VisibleFrom(ReadStore(meta), Here{WorkspaceId: "w"}, Names{Workspace: "Acme\u001b[2J\u0007"})
	if len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	b := got[0]
	for _, s := range []string{b.Title, b.Description, b.Places[0].Folder, b.Places[0].Name} {
		for _, r := range s {
			if r < ' ' && r != '\n' {
				t.Errorf("control character %q in %q", r, s)
			}
		}
	}
	if b.Description != "Line one\nline two[2Jend" || b.Places[0].Folder != "Ops[31m team" || strings.Contains(b.Title, "\n") || b.Places[0].Name != "Acme[2J" {
		t.Errorf("texts: %+v", b)
	}
}

func TestProjectOfIsTheTabsProjectElseTheCurrentOne(t *testing.T) {
	t.Parallel()
	var m waveobj.MetaMapType
	raw := `{
	  "molten:projects": [
	    {"id": "p1", "type": "Desktop", "dir": "/work/app"},
	    {"id": "p2", "type": "", "dir": "/work/site"}
	  ],
	  "molten:currentproject": "p1",
	  "molten:project": "/work/app",
	  "molten:projecttype": "Desktop",
	  "molten:tabprojects": {"tab-web": "p2", "tab-app": "p1", "tab-gone": "p9"}
	}`
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		tab, id, name string
	}{
		{"tab-web", "p2", "site"},
		{"tab-app", "p1", "Desktop"},
		{"tab-unmapped", "p1", "Desktop"},
		{"tab-gone", "p1", "Desktop"},
		{"", "p1", "Desktop"},
	}
	for _, c := range cases {
		got, ok := ProjectOf(m, c.tab)
		if !ok || got.Id != c.id || got.Name != c.name {
			t.Errorf("tab %q: %+v %v, want %s %s", c.tab, got, ok, c.id, c.name)
		}
	}
	if _, ok := ProjectOf(waveobj.MetaMapType{}, "tab-x"); ok {
		t.Error("a workspace without a project has no project place")
	}
	single, ok := ProjectOf(waveobj.MetaMapType{"molten:project": "/work/app"}, "tab-x")
	if !ok || single.Id != "p1" || single.Name != "app" {
		t.Errorf("one project without a list reads as p1: %+v %v", single, ok)
	}
}
