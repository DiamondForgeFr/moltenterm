// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestFormatMoltenBookmarksGroupsByFolderAndKeepsTheNote(t *testing.T) {
	view := molten.BookmarksView{
		Project: molten.BookmarksProject{Id: "p1", Name: "Desktop"},
		Bookmarks: []molten.Bookmark{
			{Title: "Staging", Url: "https://staging.example.com/"},
			{Title: "Vite  config", Url: "https://vite.dev/config/", Folder: "Docs", Description: "The build options\nthe renderer relies on."},
			{Title: "Signed", Folder: "Docs", Withheld: true, Description: "Keep for the report."},
		},
	}
	want := "Bookmarks of project Desktop (3):\n" +
		"\n" +
		"- Staging: https://staging.example.com/\n" +
		"\n" +
		"Folder Docs\n" +
		"- Vite config: https://vite.dev/config/\n" +
		"  The build options the renderer relies on.\n" +
		"- Signed: (address withheld: it carries a credential)\n" +
		"  Keep for the report.\n"
	if got := formatMoltenBookmarks(view); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatMoltenBookmarksSaysWhenThereIsNone(t *testing.T) {
	got := formatMoltenBookmarks(molten.BookmarksView{Project: molten.BookmarksProject{Id: "p2", Name: "Website"}})
	if !strings.Contains(got, "No bookmark in project Website") || !strings.Contains(got, "developer adds") {
		t.Fatalf("got %q", got)
	}
}

func TestMoltenBookmarksOnlyHasAListing(t *testing.T) {
	names := []string{}
	for _, c := range moltenBookmarksCmd.Commands() {
		names = append(names, c.Name())
	}
	if len(names) != 1 || names[0] != "list" {
		t.Fatalf("agents only read bookmarks: %v", names)
	}
}
