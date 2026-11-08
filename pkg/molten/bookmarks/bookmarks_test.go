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
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A workspace of two projects, as the database hands it over after a round trip through JSON: Desktop (p1, the current
// one) and Website (p2); tab-web belongs to Website.
const twoProjects = `{
  "molten:projects": [
    {"id": "p1", "type": "Desktop", "dir": "/work/app"},
    {"id": "p2", "type": "", "dir": "/work/site"}
  ],
  "molten:currentproject": "p1",
  "molten:project": "/work/app",
  "molten:projecttype": "Desktop",
  "molten:tabprojects": {"tab-web": "p2", "tab-app": "p1", "tab-gone": "p9"},
  "molten:bookmarks": {
    "p1": {
      "folders": [{"id": "f1", "name": "Docs"}, {"id": "f2", "name": "Ops"}],
      "items": [
        {"id": "b1", "url": "https://vite.dev/config/", "title": "Vite config", "description": "The build options the renderer relies on.", "folder": "f1"},
        {"id": "b2", "url": "https://staging.example.com/", "title": "Staging", "description": "", "folder": ""},
        {"id": "b3", "url": "https://grafana.example.com/d/abc?token=SECRET&orgId=1", "title": "Dashboards", "description": "Latency and errors.", "folder": "f2"},
        {"id": "b4", "url": "https://example.com/lost", "title": "Lost folder", "description": "", "folder": "f-removed"}
      ]
    },
    "p2": {
      "items": [{"id": "b5", "url": "https://site.example.com/", "title": "Site", "description": "The marketing site."}]
    }
  }
}`

func meta(t *testing.T, raw string) waveobj.MetaMapType {
	t.Helper()
	var m waveobj.MetaMapType
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func titles(list []molten.Bookmark) []string {
	rtn := []string{}
	for _, b := range list {
		rtn = append(rtn, b.Title)
	}
	return rtn
}

func TestReadGivesOneProjectsBookmarksRootFirstThenFolders(t *testing.T) {
	m := meta(t, twoProjects)
	got := Read(m, "p1")
	if want := []string{"Staging", "Lost folder", "Vite config", "Dashboards"}; !reflect.DeepEqual(titles(got), want) {
		t.Fatalf("p1 = %v, want %v", titles(got), want)
	}
	if got[2].Folder != "Docs" || got[2].Description != "The build options the renderer relies on." || got[1].Folder != "" {
		t.Fatalf("folders and descriptions: %+v", got)
	}
	other := Read(m, "p2")
	if len(other) != 1 || other[0].Title != "Site" {
		t.Fatalf("p2 = %+v", other)
	}
	if Read(m, "p3") != nil || Read(meta(t, `{}`), "p1") != nil {
		t.Fatal("a project without bookmarks reads as none")
	}
}

func TestReadNeverGivesAnAgentACredential(t *testing.T) {
	m := meta(t, `{"molten:bookmarks": {"p1": {"items": [
      {"id": "a", "url": "https://user:pass@example.com/page?token=abc&page=2", "title": "With userinfo"},
      {"id": "b", "url": "https://bucket.example.com/f?X-Amz-Signature=abc&X-Amz-Expires=60", "title": "Signed", "description": "Keep for the report."},
      {"id": "c", "url": "https://app.example.com/callback#access_token=abc123&state=xyz", "title": "OAuth return"},
      {"id": "d", "url": "https://shop.example.com/reset#9f8e7d6c5b4a", "title": "Reset link"},
      {"id": "e", "url": "https://docs.example.com/guide#install", "title": "Anchor"}
    ]}}}`)
	got := Read(m, "p1")
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

func TestReadIgnoresWhatIsNotAWebAddress(t *testing.T) {
	m := meta(t, `{"molten:bookmarks": {"p1": {"items": [
      {"id": "a", "url": "javascript:alert(document.cookie)", "title": "Script"},
      {"id": "b", "url": "file:///etc/passwd", "title": "File"},
      {"id": "c", "url": "data:text/html,<b>x</b>", "title": "Data"},
      {"id": "d", "url": "vscode://file/etc/hosts", "title": "Editor"},
      {"id": "e", "url": "ftp://example.com/", "title": "Ftp"},
      {"id": "f", "url": "https:///nohost", "title": "No host"},
      {"id": "g", "url": "not an address", "title": "Words"},
      {"id": "h", "url": "https://ok.example.com/", "title": "Ok"}
    ]}}}`)
	got := Read(m, "p1")
	if len(got) != 1 || got[0].Title != "Ok" {
		t.Fatalf("only the web address stays, and nothing is given as withheld for the rest: %+v", got)
	}
}

func TestReadCutsWhatIsReadToTheLimits(t *testing.T) {
	var folders, items []any
	for i := 0; i < maxFolders+10; i++ {
		folders = append(folders, map[string]any{"id": fmt.Sprintf("f%d", i), "name": fmt.Sprintf("Folder %d", i)})
	}
	folders[0] = map[string]any{"id": "f0", "name": strings.Repeat("n", maxFolderName+30)}
	for i := 0; i < maxBookmarks+40; i++ {
		items = append(items, map[string]any{"id": fmt.Sprintf("b%d", i), "url": fmt.Sprintf("https://example.com/%d", i), "title": fmt.Sprintf("Page %d", i), "folder": "f0"})
	}
	items[0] = map[string]any{
		"id": "b0", "url": "https://example.com/0", "folder": "f0",
		"title":       strings.Repeat("t", maxTitle+100),
		"description": strings.Repeat("d", maxDescription+100),
	}
	items[1] = map[string]any{"id": "b1", "url": "https://example.com/" + strings.Repeat("a", maxAddress), "title": "Too long"}
	m := waveobj.MetaMapType{molten.BookmarksMetaKey: map[string]any{"p1": map[string]any{"folders": folders, "items": items}}}
	got := Read(m, "p1")
	if len(got) != maxBookmarks {
		t.Fatalf("%d bookmarks, want %d", len(got), maxBookmarks)
	}
	if len([]rune(got[0].Title)) != maxTitle || len([]rune(got[0].Description)) != maxDescription || len([]rune(got[0].Folder)) != maxFolderName {
		t.Errorf("texts cut: title %d, description %d, folder %d", len(got[0].Title), len(got[0].Description), len(got[0].Folder))
	}
	for _, b := range got {
		if b.Title == "Too long" {
			t.Errorf("an address over the limit was given: %+v", b)
		}
	}
	// A folder past the limit is not one: its bookmarks read as directly in the project.
	items[2] = map[string]any{"id": "b2", "url": "https://example.com/2", "title": "Lost", "folder": fmt.Sprintf("f%d", maxFolders+5)}
	for _, b := range Read(m, "p1") {
		if b.Title == "Lost" && b.Folder != "" {
			t.Errorf("a folder past the limit: %+v", b)
		}
	}
}

func TestReadRemovesControlCharactersFromTheTexts(t *testing.T) {
	m := meta(t, `{"molten:bookmarks": {"p1": {"folders": [{"id": "f", "name": "Ops\u001b[31m\nteam"}], "items": [
      {"id": "a", "url": "https://example.com/", "title": "Docs\u001b]0;pwned\u0007 now", "description": "Line one\nline\ttwo\u001b[2J\u0000end", "folder": "f"}
    ]}}}`)
	got := Read(m, "p1")
	if len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	for _, s := range []string{got[0].Title, got[0].Description, got[0].Folder} {
		for _, r := range s {
			if r < ' ' && r != '\n' {
				t.Errorf("control character %q in %q", r, s)
			}
		}
	}
	if got[0].Description != "Line one\nline two[2Jend" || got[0].Folder != "Ops[31m team" || strings.Contains(got[0].Title, "\n") {
		t.Errorf("texts: %+v", got[0])
	}
}

func TestReadNamesAnUntitledWithheldBookmarkByItsHost(t *testing.T) {
	m := meta(t, `{"molten:bookmarks": {"p1": {"items": [
      {"id": "a", "url": "https://bucket.example.com/f?X-Amz-Signature=abc&X-Amz-Expires=60"}
    ]}}}`)
	got := Read(m, "p1")
	if len(got) != 1 || !got[0].Withheld || got[0].Title != "bucket.example.com" {
		t.Fatalf("an untitled bookmark whose address is withheld shows its host as its title: %+v", got)
	}
}

func TestReadSurvivesMalformedValues(t *testing.T) {
	for _, raw := range []string{
		`{"molten:bookmarks": "oops"}`,
		`{"molten:bookmarks": {"p1": "oops"}}`,
		`{"molten:bookmarks": {"p1": {"folders": "x", "items": [1, "a", null, {"url": 4}]}}}`,
		`{"molten:bookmarks": {"p1": {"folders": [{"id": "", "name": "x"}, {"id": "f", "name": ""}], "items": [{"url": "https://a.example.com", "folder": "f"}]}}}`,
	} {
		got := Read(meta(t, raw), "p1")
		for _, b := range got {
			if b.Url != "" && b.Folder != "" {
				t.Errorf("%s: %+v", raw, b)
			}
		}
	}
	if got := Read(meta(t, `{"molten:bookmarks": {"p1": {"items": [{"url": "https://a.example.com"}]}}}`), "p1"); len(got) != 1 || got[0].Title != "https://a.example.com" {
		t.Errorf("an untitled bookmark is named by its address: %+v", got)
	}
}

func TestProjectOfIsTheTabsProjectElseTheCurrentOne(t *testing.T) {
	m := meta(t, twoProjects)
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
	if _, ok := ProjectOf(meta(t, `{}`), "tab-x"); ok {
		t.Error("a workspace without a project has no bookmarks")
	}
	single, ok := ProjectOf(meta(t, `{"molten:project": "/work/app"}`), "tab-x")
	if !ok || single.Id != "p1" || single.Name != "app" {
		t.Errorf("one project without a list reads as p1: %+v %v", single, ok)
	}
}

func TestWithoutProjectDropsOnlyThatProjectsEntry(t *testing.T) {
	m := meta(t, twoProjects)
	value, changed := WithoutProject(m, "p2")
	if !changed {
		t.Fatal("p2 had an entry")
	}
	left, _ := value.(map[string]any)
	if _, has := left["p1"]; !has || len(left) != 1 {
		t.Fatalf("left = %v", left)
	}
	if _, has := m[molten.BookmarksMetaKey].(map[string]any)["p2"]; !has {
		t.Fatal("the workspace's own meta was changed")
	}
	if _, changed := WithoutProject(m, "p9"); changed {
		t.Error("a project without an entry changes nothing")
	}
	only := meta(t, `{"molten:bookmarks": {"p1": {"items": []}}}`)
	if value, changed := WithoutProject(only, "p1"); !changed || value != nil {
		t.Errorf("the last entry deletes the key: %v %v", value, changed)
	}
}

func fakeReader(m waveobj.MetaMapType, tab string) workspaceReader {
	return func(blockId string) (waveobj.MetaMapType, string, error) {
		if blockId != "block-1" {
			return nil, "", fmt.Errorf("block %s not found", blockId)
		}
		return m, tab, nil
	}
}

func TestRouteListsTheTerminalsProjectOnly(t *testing.T) {
	m := meta(t, twoProjects)
	term := localroute.Caller{IsLocalTerminal: true, BlockId: "block-1"}
	out, err := (&routeLink{read: fakeReader(m, "tab-web")}).handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{BlockId: "block-1"})
	if err != nil {
		t.Fatal(err)
	}
	view := out.(molten.BookmarksView)
	if view.Project.Id != "p2" || len(view.Bookmarks) != 1 || view.Bookmarks[0].Title != "Site" {
		t.Fatalf("a terminal of the Website tab reads Website's bookmarks: %+v", view)
	}
	out, err = (&routeLink{read: fakeReader(m, "tab-app")}).handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{BlockId: "block-1"})
	if err != nil || out.(molten.BookmarksView).Project.Id != "p1" || len(out.(molten.BookmarksView).Bookmarks) != 4 {
		t.Fatalf("Desktop: %+v %v", out, err)
	}
	empty, err := (&routeLink{read: fakeReader(meta(t, `{"molten:project": "/work/app"}`), "t")}).handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{BlockId: "block-1"})
	if err != nil || empty.(molten.BookmarksView).Bookmarks == nil {
		t.Errorf("a project without a bookmark lists an empty array: %+v %v", empty, err)
	}
}

func TestRouteRefusesWhatIsNotAListing(t *testing.T) {
	l := &routeLink{read: fakeReader(meta(t, twoProjects), "tab-app")}
	term := localroute.Caller{IsLocalTerminal: true, BlockId: "block-1"}
	for _, command := range []string{"moltenbookmarksadd", "moltenbookmarksdelete", "moltenbookmarksset", ""} {
		if _, err := l.handle(command, term, molten.BookmarksRequest{BlockId: "block-1"}); err == nil {
			t.Errorf("%q was answered: agents only read", command)
		}
	}
	if _, err := l.handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{BlockId: "block-2"}); err == nil {
		t.Error("a terminal read another terminal's workspace")
	}
	if _, err := l.handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{}); err == nil {
		t.Error("a listing without a terminal was answered")
	}
	if _, err := (&routeLink{read: fakeReader(meta(t, `{}`), "tab")}).handle(molten.BookmarksListCommand, term, molten.BookmarksRequest{BlockId: "block-1"}); err == nil {
		t.Error("a workspace without a project was answered")
	}
	policy := l.route().Policy
	if !policy.Admits(molten.BookmarksListCommand, term) || policy.Admits(molten.BookmarksListCommand, localroute.Caller{}) {
		t.Error("only local callers list")
	}
}
