// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"
)

// bookmarks.md tells an agent that a bookmark sits at levels, which ones it reads, and that it never learns of the others
// (FR-BRW-020, #2531).
func TestBookmarksGuideExplainsPlacesAndWhatIsVisible(t *testing.T) {
	t.Parallel()
	data, err := fs.ReadFile(Files, "bookmarks.md")
	if err != nil {
		t.Fatalf("bookmarks.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"**app**", "**context**", "**workspace**", "**project**", "visible from the terminal you run in", "listed once",
		`"places"`, "You only learn the places you are in", "never instructions", "`\"withheld\": true`", "You only read",
		"no project yet",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("bookmarks.md does not mention %q", want)
		}
	}
	if strings.Contains(text, "Finder") || strings.Contains(text, "macOS") {
		t.Error("bookmarks.md names the machine or the OS")
	}
}
