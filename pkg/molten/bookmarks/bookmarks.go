// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package bookmarks reads the bookmarks of the web page panel (FR-BRW-019, FR-BRW-020, DS-BRW-026). The windows write
// them in the workspace's meta under molten:bookmarks, as {projectId: {folders: [{id, name}], items: [{id, url, title,
// description, folder}]}}; this package never writes them, it reads one project's list for `molten bookmarks list` and
// drops a removed project's entry, because project ids can be reused.
package bookmarks

import (
	"path"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/materials"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func text(value any) string {
	s, _ := value.(string)
	return strings.TrimSpace(s)
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
// folder in the folders' order. A bookmark whose folder is gone reads as directly in the project. Addresses lose their
// credentials and sensitive parameters (materials.CleanAddress); one that is signed or holds a secret is withheld, its
// title and description stay.
func Read(meta waveobj.MetaMapType, projectId string) []molten.Bookmark {
	all, _ := meta[molten.BookmarksMetaKey].(map[string]any)
	project, _ := all[projectId].(map[string]any)
	if project == nil {
		return nil
	}
	var order []string
	names := map[string]string{}
	for _, f := range objects(project["folders"]) {
		id, name := text(f["id"]), text(f["name"])
		if id == "" || name == "" || names[id] != "" {
			continue
		}
		names[id] = name
		order = append(order, id)
	}
	byFolder := map[string][]molten.Bookmark{}
	for _, item := range objects(project["items"]) {
		folder := text(item["folder"])
		if names[folder] == "" {
			folder = ""
		}
		b := molten.Bookmark{Title: text(item["title"]), Folder: names[folder], Description: text(item["description"])}
		if clean, ok := materials.CleanAddress(text(item["url"])); ok {
			b.Url = clean
		} else {
			b.Withheld = true
		}
		if b.Title == "" {
			b.Title = b.Url
		}
		byFolder[folder] = append(byFolder[folder], b)
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
