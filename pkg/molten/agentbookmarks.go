// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

// Bookmarks of the web page panel, kept per project (FR-BRW-019, DS-BRW-026): the windows write them in the workspace's
// meta, `molten bookmarks list` reads them through a leaf of wavesrv's router (pkg/molten/bookmarks). These names are
// shared with wsh and the window.

const (
	// BookmarksMetaKey is the workspace meta that holds every project's bookmarks. must match
	// frontend/moltenterm-shell/browser/bookmarks.ts
	BookmarksMetaKey = "molten:bookmarks"

	BookmarksRoute       = "molten:bookmarks"
	BookmarksListCommand = "moltenbookmarkslist"
)

// BookmarksRequest names the terminal that asks; its tab gives the project.
type BookmarksRequest struct {
	BlockId string `json:"blockid,omitempty"`
}

// Bookmark is one bookmark as an agent reads it: its folder is the folder's name, "" for a bookmark directly in the
// project. Withheld: the address carried a credential and is not given.
type Bookmark struct {
	Title       string `json:"title"`
	Url         string `json:"url"`
	Folder      string `json:"folder"`
	Description string `json:"description"`
	Withheld    bool   `json:"withheld,omitempty"`
}

// BookmarksProject names the project a list belongs to.
type BookmarksProject struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

// BookmarksView is a list's answer: the project's bookmarks, those directly in the project first, then folder by
// folder.
type BookmarksView struct {
	Project   BookmarksProject `json:"project"`
	Bookmarks []Bookmark       `json:"bookmarks"`
}
