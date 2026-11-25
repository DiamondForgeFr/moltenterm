// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package bookmarks reads the bookmarks of the web page panel (FR-BRW-019, FR-BRW-020, DS-BRW-026, #2531). A bookmark is
// one record placed at one or several places, and a place is a level: the app, a context, a workspace or a project.
// Because one record may sit at several levels, all of them live in one value, the client's meta under molten:bookmarks:
// {records: [{id, url, title, description, places: [{level, id, folder}]}], folders: {<place key>: [{id, name}]}}. The
// windows write it; this package holds the rules wavesrv applies: what a terminal's place can see for
// `molten bookmarks list`, the move of the per-project bookmarks of an earlier version into places, and the drop of the
// places of a project, a workspace or a context that is gone, because ids can be reused.
package bookmarks

import (
	"net/url"
	"path"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/materials"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The limits of the bookmarks. must match BookmarkLimits in frontend/moltenterm-shell/browser/bookmarks.ts
const (
	maxBookmarks   = 300
	maxFolders     = 50
	maxTitle       = 200
	maxAddress     = 2048
	maxDescription = 1000
	maxFolderName  = 60
	maxRecords     = 3000
	maxPlaces      = 32
)

// Not limits the window knows: a cut that keeps an id or the name of a place from being a wall of text.
const (
	maxIdLength  = 200
	maxPlaceName = 200
)

func text(value any) string {
	s, _ := value.(string)
	return strings.TrimSpace(s)
}

// clean is a text as an agent reads it: without control characters (a terminal would act on an escape sequence), cut
// to its limit; a title or a name is one line, a description keeps its line breaks.
func clean(value any, max int, multiline bool) string {
	s, _ := value.(string)
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' && multiline:
			sb.WriteRune(r)
		case r == '\t' || r == '\r' || r == '\n':
			sb.WriteRune(' ')
		case unicode.IsControl(r):
		default:
			sb.WriteRune(r)
		}
	}
	rtn := strings.TrimSpace(sb.String())
	if !multiline {
		rtn = strings.Join(strings.Fields(rtn), " ")
	}
	if runes := []rune(rtn); len(runes) > max {
		rtn = strings.TrimSpace(string(runes[:max]))
	}
	return rtn
}

// address is a bookmark's address as an agent reads it. ok is false for what is not a web address: only http and
// https are kept, whoever wrote the meta. The fragment is dropped (an OAuth redirect carries its token there), then
// credentials and sensitive parameters; an address that is signed or holds a secret is withheld, not given.
func address(raw string) (cleaned string, host string, withheld bool, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || len(raw) > maxAddress {
		return "", "", false, false
	}
	host = u.Hostname()
	u.Fragment = ""
	u.RawFragment = ""
	cleaned, good := materials.CleanAddress(u.String())
	if !good {
		return "", host, true, true
	}
	return cleaned, host, false, true
}

func objects(value any) []map[string]any {
	var rtn []map[string]any
	list, _ := value.([]any)
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			rtn = append(rtn, m)
		}
	}
	return rtn
}

func projectName(p projectviews.Project) string {
	if p.Type != "" {
		return p.Type
	}
	return path.Base(strings.ReplaceAll(strings.TrimRight(p.Dir, "/\\"), "\\", "/"))
}

// ProjectOf is the project a terminal's tab belongs to: its owner in the workspace's tab map, else the current project.
// ok is false for a workspace without a project.
func ProjectOf(meta waveobj.MetaMapType, tabId string) (molten.BookmarksProject, bool) {
	projects := projectviews.ReadProjects(meta)
	if len(projects) == 0 {
		return molten.BookmarksProject{}, false
	}
	id := projectviews.CurrentProjectId(meta)
	if owner := projectviews.ReadTabProjects(meta)[tabId]; owner != "" {
		if _, found := projectviews.FindProject(projects, owner); found {
			id = owner
		}
	}
	p, _ := projectviews.FindProject(projects, id)
	return molten.BookmarksProject{Id: p.Id, Name: projectName(p)}, true
}
