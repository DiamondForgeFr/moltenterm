// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestFormatMoltenBookmarksListsEachOnceWithItsPlacesAndKeepsTheNote(t *testing.T) {
	t.Parallel()
	view := molten.BookmarksView{
		Project:   molten.BookmarksProject{Id: "p1", Name: "site-web"},
		Workspace: "Acme",
		Context:   "Client SEFERS",
		Bookmarks: []molten.Bookmark{
			{Title: "Staging", Url: "https://staging.example.com/", Places: []molten.BookmarkPlace{{Level: "project", Name: "site-web"}, {Level: "app"}}},
			{
				Title: "Vite  config", Url: "https://vite.dev/config/", Description: "The build options\nthe renderer relies on.",
				Places: []molten.BookmarkPlace{{Level: "project", Name: "site-web", Folder: "Docs"}, {Level: "context", Name: "Client SEFERS"}, {Level: "app"}},
			},
			{Title: "Signed", Withheld: true, Description: "Keep for the report.", Places: []molten.BookmarkPlace{{Level: "workspace", Name: "Acme", Folder: "Ops"}}},
		},
	}
	want := "Bookmarks visible from project site-web, workspace Acme, context Client SEFERS (3):\n" +
		"\n" +
		"- Staging: https://staging.example.com/\n" +
		"  places: project site-web, app\n" +
		"- Vite config: https://vite.dev/config/\n" +
		"  places: project site-web (folder Docs), context Client SEFERS, app\n" +
		"  The build options the renderer relies on.\n" +
		"- Signed: (address withheld: it carries a credential)\n" +
		"  places: workspace Acme (folder Ops)\n" +
		"  Keep for the report.\n"
	if got := formatMoltenBookmarks(view); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatMoltenBookmarksNamesTheWorkspaceWhenThereIsNoProject(t *testing.T) {
	t.Parallel()
	view := molten.BookmarksView{
		Workspace: "Acme",
		Context:   "Client SEFERS",
		Bookmarks: []molten.Bookmark{{Title: "Docs", Url: "https://docs.example.com/", Places: []molten.BookmarkPlace{{Level: "workspace", Name: "Acme"}}}},
	}
	got := formatMoltenBookmarks(view)
	if !strings.HasPrefix(got, "Bookmarks visible from workspace Acme, context Client SEFERS (1):\n") || strings.Contains(got, "project") {
		t.Fatalf("got %q", got)
	}
}

func TestFormatMoltenBookmarksNeverPrintsAnEmptyTitle(t *testing.T) {
	t.Parallel()
	got := formatMoltenBookmarks(molten.BookmarksView{
		Project:   molten.BookmarksProject{Id: "p1", Name: "Desktop"},
		Bookmarks: []molten.Bookmark{{Withheld: true, Description: "Expires.", Places: []molten.BookmarkPlace{{Level: "app"}}}},
	})
	if !strings.Contains(got, "- (untitled): (address withheld: it carries a credential)\n") || strings.Contains(got, "- :") {
		t.Fatalf("got %q", got)
	}
}

func TestFormatMoltenBookmarksSaysWhenThereIsNoneAndHowToAddOne(t *testing.T) {
	t.Parallel()
	got := formatMoltenBookmarks(molten.BookmarksView{Project: molten.BookmarksProject{Id: "p2", Name: "Website"}, Workspace: "Acme", Context: "Client"})
	for _, want := range []string{"No bookmark is visible from project Website, workspace Acme, context Client", "developer adds one", "bookmark icon after Reload"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q lacks %q", got, want)
		}
	}
	if got := formatMoltenBookmarks(molten.BookmarksView{}); !strings.Contains(got, "visible from here yet") {
		t.Fatalf("a view that names nothing reads as here: %q", got)
	}
}

func TestMoltenBookmarksJsonCarriesThePlaces(t *testing.T) {
	t.Parallel()
	data, err := json.Marshal([]molten.Bookmark{{Title: "Docs", Url: "https://docs.example.com/", Places: []molten.BookmarkPlace{{Level: "project", Name: "site-web", Folder: "Docs"}, {Level: "app"}}}})
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"title":"Docs","url":"https://docs.example.com/","places":[{"level":"project","name":"site-web","folder":"Docs"},{"level":"app","folder":""}],"description":""}]`
	if string(data) != want {
		t.Fatalf("got %s\nwant %s", data, want)
	}
}

func TestMoltenBookmarksOnlyHasAListing(t *testing.T) {
	t.Parallel()
	names := []string{}
	for _, c := range moltenBookmarksCmd.Commands() {
		names = append(names, c.Name())
	}
	if len(names) != 1 || names[0] != "list" {
		t.Fatalf("agents only read bookmarks: %v", names)
	}
}
