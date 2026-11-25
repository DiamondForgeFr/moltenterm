// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"slices"
	"strings"
)

// A project, a workspace or a context that is removed takes its places with it: ids are reused (the next free "pN" for a
// project), so a place left behind would give the next one of that id the removed one's bookmarks. A record that has no
// place left goes too. Each function returns the store without them, and whether it changed anything; none changes the
// store it is given.

func without(store Store, drop func(level string, id string) bool) (Store, bool) {
	rtn := Store{Records: make([]Record, 0, len(store.Records)), Folders: make(map[string][]Folder, len(store.Folders))}
	changed := false
	for _, r := range store.Records {
		kept := make([]Place, 0, len(r.Places))
		for _, p := range r.Places {
			if !drop(p.Level, p.Id) {
				kept = append(kept, p)
			}
		}
		switch {
		case len(kept) == len(r.Places):
			r.Places = slices.Clone(r.Places)
			rtn.Records = append(rtn.Records, r)
		case len(kept) > 0:
			changed = true
			r.Places = kept
			rtn.Records = append(rtn.Records, r)
		default:
			changed = true
		}
	}
	for key, list := range store.Folders {
		if level, id, ok := parsePlaceKey(key); ok && drop(level, id) {
			changed = true
			continue
		}
		rtn.Folders[key] = slices.Clone(list)
	}
	return rtn, changed
}

// WithoutProject drops a project's place and its folders.
func WithoutProject(store Store, workspaceId string, projectId string) (Store, bool) {
	id := ProjectPlaceId(workspaceId, projectId)
	return without(store, func(level string, placeId string) bool { return level == LevelProject && placeId == id })
}

// WithoutWorkspace drops a workspace's place, the places of all its projects and their folders.
func WithoutWorkspace(store Store, workspaceId string) (Store, bool) {
	prefix := workspaceId + "/"
	return without(store, func(level string, id string) bool {
		return (level == LevelWorkspace && id == workspaceId) || (level == LevelProject && strings.HasPrefix(id, prefix))
	})
}

// WithoutContext drops a context's place and its folders.
func WithoutContext(store Store, contextId string) (Store, bool) {
	return without(store, func(level string, id string) bool { return level == LevelContext && id == contextId })
}

// WorkspacePart is what belongs to a workspace in the store: the records that have a place in it or in one of its
// projects, with those places only, and the folders of those places. Deleting a workspace can be undone for a few
// seconds under the same id; the part is what undo puts back with Restore.
func WorkspacePart(store Store, workspaceId string) Store {
	rtn := Store{Folders: map[string][]Folder{}}
	prefix := workspaceId + "/"
	mine := func(level string, id string) bool {
		return (level == LevelWorkspace && id == workspaceId) || (level == LevelProject && strings.HasPrefix(id, prefix))
	}
	for _, r := range store.Records {
		var places []Place
		for _, p := range r.Places {
			if mine(p.Level, p.Id) {
				places = append(places, p)
			}
		}
		if len(places) > 0 {
			r.Places = places
			rtn.Records = append(rtn.Records, r)
		}
	}
	for key, list := range store.Folders {
		if level, id, ok := parsePlaceKey(key); ok && mine(level, id) {
			rtn.Folders[key] = slices.Clone(list)
		}
	}
	return rtn
}

// Restore puts a WorkspacePart back: a record the store still has (it sits at other places too) gets its places back,
// any other is added, with a new id when another record took its id meanwhile; the folders of a place come back when
// the store holds none for it.
func Restore(store Store, part Store) Store {
	rtn := store.clone()
	used := map[string]bool{}
	for _, r := range rtn.Records {
		used[r.Id] = true
	}
	for _, r := range part.Records {
		at := slices.IndexFunc(rtn.Records, func(have Record) bool { return have.Id == r.Id && have.Url == r.Url })
		if at >= 0 {
			for _, p := range r.Places {
				if _, has := placeAt(rtn.Records[at], PlaceKey(p.Level, p.Id)); !has {
					rtn.Records[at].Places = append(rtn.Records[at].Places, p)
				}
			}
			continue
		}
		if used[r.Id] {
			r.Id = freshRecordId(used)
		}
		used[r.Id] = true
		r.Places = slices.Clone(r.Places)
		rtn.Records = append(rtn.Records, r)
	}
	for key, list := range part.Folders {
		if len(rtn.Folders[key]) == 0 {
			rtn.Folders[key] = slices.Clone(list)
		}
	}
	return rtn
}
