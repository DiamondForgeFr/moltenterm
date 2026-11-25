// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

// Bookmarks of the web page panel (FR-BRW-019, DS-BRW-026, #2531): a bookmark is one record placed at one or several
// places, and a place is a level (the app, a context, a workspace or a project). Every record lives in the client's meta,
// the windows write them there, and `molten bookmarks list` reads the ones visible from a terminal through a leaf of
// wavesrv's router (pkg/molten/bookmarks). These names are shared with wsh and the window.

const (
	// BookmarksMetaKey is the client meta that holds every bookmark, whatever its places: {records, folders}. must match
	// frontend/moltenterm-shell/browser/bookmarks.ts
	BookmarksMetaKey = "molten:bookmarks"

	// BookmarksLegacyMetaKey is the workspace meta that held each project's bookmarks before places existed. Only the
	// migration at start reads it, and deletes it.
	BookmarksLegacyMetaKey = "molten:bookmarks"

	BookmarksRoute       = "molten:bookmarks"
	BookmarksListCommand = "moltenbookmarkslist"
)

// BookmarksRequest names the terminal that asks; its tab gives the project.
type BookmarksRequest struct {
	BlockId string `json:"blockid,omitempty"`
}

// BookmarkPlace is where a bookmark sits, as far as the terminal that reads it may know: its level (app, context,
// workspace or project), the place's name ("" for the app) and the name of the folder it is in there ("" when it is
// directly in the place).
type BookmarkPlace struct {
	Level  string `json:"level"`
	Name   string `json:"name,omitempty"`
	Folder string `json:"folder"`
}

// Bookmark is one bookmark as an agent reads it, once, with the places it has among those visible from the terminal and
// no other. Withheld: the address carried a credential and is not given.
type Bookmark struct {
	Title       string          `json:"title"`
	Url         string          `json:"url"`
	Places      []BookmarkPlace `json:"places"`
	Description string          `json:"description"`
	Withheld    bool            `json:"withheld,omitempty"`
}

// BookmarksProject names the project a list is read from.
type BookmarksProject struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

// BookmarksView is a list's answer: the bookmarks visible from the terminal's place, the most specific place first. The
// project is empty for a workspace that has none yet.
type BookmarksView struct {
	Project   BookmarksProject `json:"project"`
	Workspace string           `json:"workspace,omitempty"`
	Context   string           `json:"context,omitempty"`
	Bookmarks []Bookmark       `json:"bookmarks"`
}
