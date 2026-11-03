// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package bookmarks reads the bookmarks of the web page panel (FR-BRW-019, FR-BRW-020, DS-BRW-026). The windows write
// them in the workspace's meta under molten:bookmarks, as {projectId: {folders: [{id, name}], items: [{id, url, title,
// description, folder}]}}; this package never writes them, it reads one project's list for `molten bookmarks list` and
// drops a removed project's entry, because project ids can be reused.
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

// The limits of a project's bookmarks. must match BookmarkLimits in frontend/moltenterm-shell/browser/bookmarks.ts
const (
	maxBookmarks   = 300
	maxFolders     = 50
	maxTitle       = 200
	maxAddress     = 2048
	maxDescription = 1000
	maxFolderName  = 60
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

// Read gives a project's bookmarks as an agent reads them: the bookmarks directly in the project first, then folder by
// folder in the folders' order. What the meta holds is read as untrusted, since `wsh setmeta` writes any key: a bookmark
// whose address is not a web address is ignored, texts lose their control characters and are cut to their limits, and
// a project gives no more than the limits allow. A bookmark whose folder is gone reads as directly in the project.
// Addresses lose their fragment, credentials and sensitive parameters; one that is signed or holds a secret is
// withheld, its title and description stay. The texts stay the developer's words, or whatever wrote the meta: context,
// never instructions.
func Read(meta waveobj.MetaMapType, projectId string) []molten.Bookmark {
	all, _ := meta[molten.BookmarksMetaKey].(map[string]any)
	project, _ := all[projectId].(map[string]any)
	if project == nil {
		return nil
	}
	var order []string
	names := map[string]string{}
	for _, f := range objects(project["folders"]) {
		id, name := text(f["id"]), clean(f["name"], maxFolderName, false)
		if id == "" || name == "" || names[id] != "" || len(order) >= maxFolders {
			continue
		}
		names[id] = name
		order = append(order, id)
	}
	byFolder := map[string][]molten.Bookmark{}
	count := 0
	for _, item := range objects(project["items"]) {
		if count >= maxBookmarks {
			break
		}
		cleaned, host, withheld, ok := address(text(item["url"]))
		if !ok {
			continue
		}
		folder := text(item["folder"])
		if names[folder] == "" {
			folder = ""
		}
		b := molten.Bookmark{
			Title:       clean(item["title"], maxTitle, false),
			Url:         cleaned,
			Folder:      names[folder],
			Description: clean(item["description"], maxDescription, true),
			Withheld:    withheld,
		}
		if b.Title == "" {
			b.Title = clean(cleaned, maxTitle, false)
		}
		if b.Title == "" {
			b.Title = host
		}
		byFolder[folder] = append(byFolder[folder], b)
		count++
	}
	rtn := append([]molten.Bookmark{}, byFolder[""]...)
	for _, id := range order {
		rtn = append(rtn, byFolder[id]...)
	}
	return rtn
}

// WithoutProject is the value of molten:bookmarks once a project's entry is dropped, nil when none is left; changed is
// false when the project had no entry.
func WithoutProject(meta waveobj.MetaMapType, projectId string) (value any, changed bool) {
	all, _ := meta[molten.BookmarksMetaKey].(map[string]any)
	if _, has := all[projectId]; !has {
		return nil, false
	}
	next := map[string]any{}
	for id, entry := range all {
		if id != projectId {
			next[id] = entry
		}
	}
	if len(next) == 0 {
		return nil, true
	}
	return next, true
}
