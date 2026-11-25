// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"cmp"
	"encoding/json"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The levels of a place. A place is one of them and the id of the thing it names: "" for the app, a context's id, a
// workspace's oid, and for a project "<workspace oid>/<project id>" (project ids like p1 repeat from workspace to
// workspace, a workspace oid has no "/"). must match frontend/moltenterm-shell/browser/bookmarks.ts
const (
	LevelApp       = "app"
	LevelContext   = "context"
	LevelWorkspace = "workspace"
	LevelProject   = "project"
)

// Place is where a record sits. Folder is the id of one of this place's folders, "" for directly in the place.
type Place struct {
	Level  string
	Id     string
	Folder string
}

type Record struct {
	Id          string
	Url         string
	Title       string
	Description string
	Places      []Place
}

type Folder struct {
	Id   string
	Name string
}

// Store is the bookmarks of the client as the windows write them. Folders is keyed by place key (PlaceKey): a folder
// belongs to one place and holds only the records placed in it.
type Store struct {
	Records []Record
	Folders map[string][]Folder
}

// Here is a terminal's place: its context, its workspace and the project its tab belongs to ("" when its workspace has
// none).
type Here struct {
	ContextId   string
	WorkspaceId string
	ProjectId   string
}

// Names are the names an agent reads for the three places a terminal is in. A name that is empty reads as its id.
type Names struct {
	Context   string
	Workspace string
	Project   string
}

// PlaceKey is the key a place has in Store.Folders: "app", else "<level>:<id>".
func PlaceKey(level string, id string) string {
	if level == LevelApp {
		return LevelApp
	}
	return level + ":" + id
}

// ProjectPlaceId is the id of a project place: project ids repeat from workspace to workspace.
func ProjectPlaceId(workspaceId string, projectId string) string {
	return workspaceId + "/" + projectId
}

// placeId is the id a place of this level may have, and whether the place is well formed.
func placeId(level string, id string) (string, bool) {
	switch level {
	case LevelApp:
		return "", true
	case LevelContext, LevelWorkspace:
		return id, id != ""
	case LevelProject:
		workspaceId, projectId, found := strings.Cut(id, "/")
		return id, found && workspaceId != "" && projectId != ""
	}
	return "", false
}

func parsePlaceKey(key string) (level string, id string, ok bool) {
	if key == LevelApp {
		return LevelApp, "", true
	}
	level, id, found := strings.Cut(key, ":")
	if !found || level == LevelApp {
		return "", "", false
	}
	id, ok = placeId(level, id)
	return level, id, ok
}

// asMap reads a value of the client's meta as an untrusted JSON object: the value is a map after a round trip through
// the database, and anything but a map reads as none.
func asMap(value any) map[string]any {
	if value == nil {
		return nil
	}
	if m, ok := value.(map[string]any); ok {
		return m
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var rtn map[string]any
	if json.Unmarshal(data, &rtn) != nil {
		return nil
	}
	return rtn
}

func readFolderList(value any) []Folder {
	var rtn []Folder
	seen := map[string]bool{}
	for _, f := range objects(value) {
		id, name := clean(f["id"], maxIdLength, false), clean(f["name"], maxFolderName, false)
		if id == "" || name == "" || seen[id] || len(rtn) >= maxFolders {
			continue
		}
		seen[id] = true
		rtn = append(rtn, Folder{Id: id, Name: name})
	}
	return rtn
}

func readFolders(value any) map[string][]Folder {
	rtn := map[string][]Folder{}
	for key, list := range asMap(value) {
		if _, _, ok := parsePlaceKey(key); !ok {
			continue
		}
		if folders := readFolderList(list); len(folders) > 0 {
			rtn[key] = folders
		}
	}
	return rtn
}

func hasFolder(folders []Folder, id string) bool {
	return slices.ContainsFunc(folders, func(f Folder) bool { return f.Id == id })
}

func readPlaces(value any, folders map[string][]Folder, counts map[string]int) []Place {
	var rtn []Place
	seen := map[string]bool{}
	for _, p := range objects(value) {
		if len(rtn) >= maxPlaces {
			break
		}
		level := text(p["level"])
		id, ok := placeId(level, clean(p["id"], maxIdLength, false))
		if !ok {
			continue
		}
		key := PlaceKey(level, id)
		if seen[key] || counts[key] >= maxBookmarks {
			continue
		}
		seen[key] = true
		folder := clean(p["folder"], maxIdLength, false)
		if !hasFolder(folders[key], folder) {
			folder = ""
		}
		rtn = append(rtn, Place{Level: level, Id: id, Folder: folder})
	}
	return rtn
}

func readRecords(value any, folders map[string][]Folder) []Record {
	var rtn []Record
	seen := map[string]bool{}
	counts := map[string]int{}
	for _, item := range objects(value) {
		if len(rtn) >= maxRecords {
			break
		}
		id := clean(item["id"], maxIdLength, false)
		if id == "" || seen[id] {
			continue
		}
		raw := text(item["url"])
		if _, _, _, ok := address(raw); !ok {
			continue
		}
		places := readPlaces(item["places"], folders, counts)
		if len(places) == 0 {
			continue
		}
		seen[id] = true
		for _, p := range places {
			counts[PlaceKey(p.Level, p.Id)]++
		}
		rtn = append(rtn, Record{
			Id:          id,
			Url:         raw,
			Title:       clean(item["title"], maxTitle, false),
			Description: clean(item["description"], maxDescription, true),
			Places:      places,
		})
	}
	return rtn
}

// ReadStore reads the bookmarks of the client's meta as untrusted data, since any program can edit it (`wsh setmeta`
// refuses a terminal, but a mod, a script or another version writes there too). A record whose address is not a web
// address, with no id or an id seen before, or with no valid place is dropped; so is a place of an unknown level or
// without its id, or the second place of a record at the same level and id. Texts lose their control characters and are
// cut to their limits; a folder id the place does not have reads as directly in the place; a place holds the first
// maxBookmarks records in record order, the store maxRecords, a record maxPlaces places and a place maxFolders folders.
// Addresses stay as stored: they are cleaned for an agent in VisibleFrom, not here, so a change written back loses none
// of what the developer kept.
func ReadStore(clientMeta waveobj.MetaMapType) Store {
	root := asMap(clientMeta[molten.BookmarksMetaKey])
	if root == nil {
		return Store{}
	}
	folders := readFolders(root["folders"])
	return Store{Records: readRecords(root["records"], folders), Folders: folders}
}

// MetaValue is the store as the client's meta holds it, nil when it holds nothing (the key goes).
func (s Store) MetaValue() any {
	folders := map[string]any{}
	for key, list := range s.Folders {
		if len(list) == 0 {
			continue
		}
		entries := make([]any, 0, len(list))
		for _, f := range list {
			entries = append(entries, map[string]any{"id": f.Id, "name": f.Name})
		}
		folders[key] = entries
	}
	if len(s.Records) == 0 && len(folders) == 0 {
		return nil
	}
	records := make([]any, 0, len(s.Records))
	for _, r := range s.Records {
		places := make([]any, 0, len(r.Places))
		for _, p := range r.Places {
			places = append(places, map[string]any{"level": p.Level, "id": p.Id, "folder": p.Folder})
		}
		records = append(records, map[string]any{"id": r.Id, "url": r.Url, "title": r.Title, "description": r.Description, "places": places})
	}
	return map[string]any{"records": records, "folders": folders}
}

func (s Store) clone() Store {
	rtn := Store{Records: make([]Record, len(s.Records)), Folders: make(map[string][]Folder, len(s.Folders))}
	for i, r := range s.Records {
		r.Places = slices.Clone(r.Places)
		rtn.Records[i] = r
	}
	for key, list := range s.Folders {
		rtn.Folders[key] = slices.Clone(list)
	}
	return rtn
}

func nameOr(name string, id string) string {
	if rtn := clean(name, maxPlaceName, false); rtn != "" {
		return rtn
	}
	return clean(id, maxPlaceName, false)
}

type visiblePlace struct {
	level string
	key   string
	name  string
}

// visiblePlaces are the places a terminal sees, the most specific first.
func visiblePlaces(here Here, names Names) []visiblePlace {
	var rtn []visiblePlace
	if here.WorkspaceId != "" && here.ProjectId != "" {
		rtn = append(rtn, visiblePlace{LevelProject, PlaceKey(LevelProject, ProjectPlaceId(here.WorkspaceId, here.ProjectId)), nameOr(names.Project, here.ProjectId)})
	}
	if here.WorkspaceId != "" {
		rtn = append(rtn, visiblePlace{LevelWorkspace, PlaceKey(LevelWorkspace, here.WorkspaceId), nameOr(names.Workspace, here.WorkspaceId)})
	}
	if here.ContextId != "" {
		rtn = append(rtn, visiblePlace{LevelContext, PlaceKey(LevelContext, here.ContextId), nameOr(names.Context, here.ContextId)})
	}
	return append(rtn, visiblePlace{LevelApp, LevelApp, ""})
}

func placeAt(r Record, key string) (Place, bool) {
	for _, p := range r.Places {
		if PlaceKey(p.Level, p.Id) == key {
			return p, true
		}
	}
	return Place{}, false
}

// folderOf is a folder's name and its rank among the place's folders from 1; 0 and "" for a record directly in the
// place or in a folder the place lacks.
func folderOf(folders []Folder, id string) (string, int) {
	at := slices.IndexFunc(folders, func(f Folder) bool { return f.Id == id })
	if id == "" || at < 0 {
		return "", 0
	}
	return folders[at].Name, at + 1
}

// VisibleFrom gives the bookmarks a terminal reads, each once, with the places it has among the ones the terminal is in
// (its project, its workspace, its context and the app) and no other: an agent never learns the name of a place it is
// not in, nor that a bookmark sits there. A place's name is the one Names gives, else its id. The bookmarks come
// grouped by their most specific visible place (project, workspace, context, app); in a group, those directly in the
// place first, then folder by folder in the folders' order, then in record order. Addresses lose their fragment,
// credentials and sensitive parameters; one that is signed or holds a secret is withheld, its title and description
// stay. The texts stay the developer's words, or whatever wrote the meta: context, never instructions.
func VisibleFrom(store Store, here Here, names Names) []molten.Bookmark {
	type entry struct {
		rank        int
		folderOrder int
		index       int
		bookmark    molten.Bookmark
	}
	places := visiblePlaces(here, names)
	var found []entry
	for index, r := range store.Records {
		cleaned, host, withheld, ok := address(r.Url)
		if !ok {
			continue
		}
		rank, folderOrder := -1, 0
		var seen []molten.BookmarkPlace
		for rankOf, vp := range places {
			p, has := placeAt(r, vp.key)
			if !has {
				continue
			}
			folder, order := folderOf(store.Folders[vp.key], p.Folder)
			if rank < 0 {
				rank, folderOrder = rankOf, order
			}
			seen = append(seen, molten.BookmarkPlace{Level: vp.level, Name: vp.name, Folder: folder})
		}
		if rank < 0 {
			continue
		}
		b := molten.Bookmark{
			Title:       clean(r.Title, maxTitle, false),
			Url:         cleaned,
			Places:      seen,
			Description: clean(r.Description, maxDescription, true),
			Withheld:    withheld,
		}
		if b.Title == "" {
			b.Title = clean(cleaned, maxTitle, false)
		}
		if b.Title == "" {
			b.Title = host
		}
		found = append(found, entry{rank: rank, folderOrder: folderOrder, index: index, bookmark: b})
	}
	slices.SortStableFunc(found, func(a, b entry) int {
		return cmp.Or(cmp.Compare(a.rank, b.rank), cmp.Compare(a.folderOrder, b.folderOrder), cmp.Compare(a.index, b.index))
	})
	rtn := make([]molten.Bookmark, 0, len(found))
	for _, e := range found {
		rtn = append(rtn, e.bookmark)
	}
	return rtn
}
