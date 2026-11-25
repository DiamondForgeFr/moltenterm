// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// WorkspaceMeta is a workspace's id and its meta, as the migration reads them.
type WorkspaceMeta struct {
	Id   string
	Meta waveobj.MetaMapType
}

func freshRecordId(used map[string]bool) string {
	for {
		id := "b-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
		if !used[id] {
			return id
		}
	}
}

// migratedBefore tells whether a record is the item a first run already moved: the same address, in the same project.
func migratedBefore(r Record, raw string, key string) bool {
	_, has := placeAt(r, key)
	return has && r.Url == raw
}

func placeCount(store Store, key string) int {
	count := 0
	for _, r := range store.Records {
		if _, has := placeAt(r, key); has {
			count++
		}
	}
	return count
}

// mergeFolders adds a project's folders to the ones its place already has, by id, up to the limit.
func mergeFolders(have []Folder, add []Folder) []Folder {
	rtn := slices.Clone(have)
	for _, f := range add {
		if len(rtn) >= maxFolders {
			break
		}
		if !hasFolder(rtn, f.Id) {
			rtn = append(rtn, f)
		}
	}
	return rtn
}

// migrateProject moves one project's legacy entry ({folders, items}) of a workspace into next.
func migrateProject(next *Store, used map[string]bool, workspaceId string, projectId string, entry map[string]any) {
	key := PlaceKey(LevelProject, ProjectPlaceId(workspaceId, projectId))
	folders := readFolderList(entry["folders"])
	if len(folders) > 0 {
		next.Folders[key] = mergeFolders(next.Folders[key], folders)
	}
	count := placeCount(*next, key)
	for _, item := range objects(entry["items"]) {
		if len(next.Records) >= maxRecords || count >= maxBookmarks {
			return
		}
		raw := text(item["url"])
		if _, _, _, ok := address(raw); !ok {
			continue
		}
		id := clean(item["id"], maxIdLength, false)
		if id != "" && used[id] {
			twin := slices.IndexFunc(next.Records, func(r Record) bool { return r.Id == id })
			if twin >= 0 && migratedBefore(next.Records[twin], raw, key) {
				continue
			}
			id = ""
		}
		if id == "" {
			id = freshRecordId(used)
		}
		folder := clean(item["folder"], maxIdLength, false)
		if !hasFolder(next.Folders[key], folder) {
			folder = ""
		}
		used[id] = true
		count++
		next.Records = append(next.Records, Record{
			Id:          id,
			Url:         raw,
			Title:       clean(item["title"], maxTitle, false),
			Description: clean(item["description"], maxDescription, true),
			Places:      []Place{{Level: LevelProject, Id: ProjectPlaceId(workspaceId, projectId), Folder: folder}},
		})
	}
}

// Migrate moves the bookmarks an earlier version kept per project in each workspace's meta
// ({projectId: {folders: [{id, name}], items: [{id, url, title, description, folder}]}} under
// molten.BookmarksLegacyMetaKey) into store: one record per item, with one project place, the item's id and folder kept
// (the id is made again only when another record already has it), and the project's folders under its place. The data is
// read as untrusted, with the limits of ReadStore. cleared lists the workspaces that held the legacy key, whatever it
// held, whose key the caller deletes in the same write as the store, so a second run finds nothing to move. A record
// that an earlier run already moved (same id, same address, same project) is not added twice.
func Migrate(store Store, workspaces []WorkspaceMeta) (Store, []string) {
	next := store.clone()
	used := map[string]bool{}
	for _, r := range next.Records {
		used[r.Id] = true
	}
	ordered := slices.Clone(workspaces)
	slices.SortStableFunc(ordered, func(a, b WorkspaceMeta) int { return strings.Compare(a.Id, b.Id) })
	var cleared []string
	for _, ws := range ordered {
		legacy, has := ws.Meta[molten.BookmarksLegacyMetaKey]
		if !has {
			continue
		}
		cleared = append(cleared, ws.Id)
		all := asMap(legacy)
		if ws.Id == "" || all == nil {
			continue
		}
		projectIds := make([]string, 0, len(all))
		for projectId := range all {
			projectIds = append(projectIds, projectId)
		}
		slices.Sort(projectIds)
		for _, projectId := range projectIds {
			entry, _ := all[projectId].(map[string]any)
			if entry == nil || projectId == "" || strings.Contains(projectId, "/") {
				continue
			}
			migrateProject(&next, used, ws.Id, projectId, entry)
		}
	}
	return next, cleared
}
