// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package projectviews holds the rules that tie a workspace's views to its projects (FR-SHELL-087, FR-SHELL-080,
// #1760): which project a view belongs to, which views a project shows, which view a project switch lands on and what
// removing a project does to the views. Everything here is pure: wcore reads the workspace and writes the answers.
//
// A workspace with two projects or more maps its tabs to projects in its meta (TabProjectsMetaKey). A tab that is not
// in the map belongs to every project: the Project tab, and every tab of a workspace with one project. Nothing in this
// package closes, moves or rebuilds a tab: a project's views are filtered out of sight, never closed.
package projectviews

import (
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	// must match frontend/moltenterm-shell/sidebar/workspace-projects.ts and pkg/molten/mission/projects_migrate.go
	ProjectsMetaKey       = "molten:projects"
	CurrentProjectMetaKey = "molten:currentproject"
	FirstProjectId        = "p1"

	// The live keys of the current project, which every panel already follows. must match liveUpdate in
	// frontend/moltenterm-shell/sidebar/workspace-projects.ts
	LiveProjectMetaKey = "molten:project"
	// The code repository inside the live project's folder (#1777). must match ProjectRepoMetaKey in pkg/molten
	LiveRepoMetaKey = "molten:projectrepo"
	LiveTypeMetaKey = "molten:projecttype"
	LiveFolderMetaKey  = "molten:folder"
	LogoOfferMetaKey   = "molten:projectlogooffer"

	// Workspace meta: {tabId: projectId}, written only once the workspace has two projects. must match
	// frontend/moltenterm-shell/hidden-tabs.ts
	TabProjectsMetaKey = "molten:tabprojects"
	// Workspace meta: {projectId: tabId}, the view last shown in each project.
	ActiveByProjectMetaKey = "molten:projectactivetab"
	// Workspace meta: the temporary views of this workspace have been given their projects once (#1760, part 1), and
	// its pinned views theirs, with a slot each (part 2).
	AssignedMetaKey       = "molten:viewprojectsv1"
	AssignedPinnedMetaKey = "molten:viewprojectsv2"
	// Workspace meta: {tabId: slot}, the slot the per-project instances of one tile share. A tile has one instance in
	// each project that showed it; the slot is the workspace's pinned view, which closes and renames as one. must match
	// frontend/moltenterm-shell/hidden-tabs.ts
	SlotsMetaKey = "molten:viewslots"
	// Tab meta, transient: the slot a reopened tile belongs to, so its instances in the other projects still share it.
	// createTabObj moves it into SlotsMetaKey and takes it off the tab.
	SlotHintMetaKey = "molten:viewslot"
	// Tab meta, transient: the project a new tab is made for (a reopened view, an agent's tab). createTabObj moves it
	// into TabProjectsMetaKey and takes it off the tab.
	ViewProjectHintMetaKey = "molten:viewproject"
	// Tab meta, set by wavesrv on an instance made for a project that had none: it opens from its slot's
	// configuration the first time it is shown, with nothing started by itself.
	SiblingMetaKey = "molten:viewsibling"
)

// Project is one entry of the workspace's project list; the current one carries the live keys' folder and type.
type Project struct {
	Id     string
	Type   string
	Dir    string
	Branch string
	Logo   string
	// Repo: the code repository chosen inside Dir, "" for none (#1777).
	Repo string
}

func str(value any) string {
	s, _ := value.(string)
	return strings.TrimSpace(s)
}

func storedProjects(meta waveobj.MetaMapType) []Project {
	var items []map[string]any
	switch list := meta[ProjectsMetaKey].(type) {
	case []any:
		for _, item := range list {
			if m, ok := item.(map[string]any); ok {
				items = append(items, m)
			}
		}
	case []map[string]any:
		items = list
	default:
		return nil
	}
	seen := map[string]bool{}
	var rtn []Project
	for _, item := range items {
		id := str(item["id"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		rtn = append(rtn, Project{Id: id, Type: str(item["type"]), Dir: str(item["dir"]), Branch: str(item["branch"]), Logo: str(item["logo"]), Repo: str(item["repo"])})
	}
	return rtn
}

// ReadProjects gives the workspace's projects in order. The current one takes its folder and type from the live keys,
// which the workspace editor and `molten project link` write; a workspace without a list reads as one project made of
// those keys. must match readProjects in frontend/moltenterm-shell/sidebar/workspace-projects.ts
func ReadProjects(meta waveobj.MetaMapType) []Project {
	liveType, liveDir, liveRepo := str(meta[LiveTypeMetaKey]), str(meta[LiveProjectMetaKey]), str(meta[LiveRepoMetaKey])
	stored := storedProjects(meta)
	if stored == nil {
		if liveDir == "" && liveType == "" {
			return nil
		}
		return []Project{{Id: FirstProjectId, Type: liveType, Dir: liveDir, Repo: liveRepo}}
	}
	currentId := currentOf(meta, stored)
	rtn := make([]Project, len(stored))
	for i, p := range stored {
		if p.Id == currentId {
			p.Type, p.Dir, p.Repo = liveType, liveDir, liveRepo
		}
		rtn[i] = p
	}
	return rtn
}

func currentOf(meta waveobj.MetaMapType, projects []Project) string {
	if len(projects) == 0 {
		return ""
	}
	wanted := str(meta[CurrentProjectMetaKey])
	for _, p := range projects {
		if p.Id == wanted {
			return wanted
		}
	}
	return projects[0].Id
}

// CurrentProjectId is the stored current project when the list holds it, else the first project; "" without projects.
func CurrentProjectId(meta waveobj.MetaMapType) string {
	return currentOf(meta, ReadProjects(meta))
}

// Multi: the workspace has two projects or more, so its views belong to projects. With one project nothing is mapped
// and nothing is filtered.
func Multi(meta waveobj.MetaMapType) bool {
	return len(ReadProjects(meta)) >= 2
}

func FindProject(projects []Project, id string) (Project, bool) {
	for _, p := range projects {
		if p.Id == id {
			return p, true
		}
	}
	return Project{}, false
}

// ListValue is the project list as the meta stores it, the current project with its live folder and type.
func ListValue(projects []Project) []any {
	rtn := make([]any, len(projects))
	for i, p := range projects {
		value := map[string]any{"id": p.Id, "type": p.Type, "dir": p.Dir}
		if p.Branch != "" {
			value["branch"] = p.Branch
		}
		if p.Logo != "" {
			value["logo"] = p.Logo
		}
		if p.Repo != "" {
			value["repo"] = p.Repo
		}
		rtn[i] = value
	}
	return rtn
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// LiveUpdate is the meta that makes a project the current one: the keys every reader follows. New terminals and agents
// start in the project's root, and the logo offer stays with the product. must match liveUpdate in
// frontend/moltenterm-shell/sidebar/workspace-projects.ts
func LiveUpdate(p Project) waveobj.MetaMapType {
	return waveobj.MetaMapType{
		CurrentProjectMetaKey: p.Id,
		LiveProjectMetaKey:    nilIfEmpty(p.Dir),
		LiveRepoMetaKey:       nilIfEmpty(p.Repo),
		LiveTypeMetaKey:       nilIfEmpty(p.Type),
		LiveFolderMetaKey:     nilIfEmpty(p.Dir),
		LogoOfferMetaKey:      nilIfEmpty(p.Dir),
	}
}

// SwitchMeta is the meta that makes another project current: the list with the current project's live values, then the
// target's live keys. ok is false when the target is already current or does not exist.
func SwitchMeta(meta waveobj.MetaMapType, targetId string) (update waveobj.MetaMapType, ok bool) {
	projects := ReadProjects(meta)
	target, found := FindProject(projects, targetId)
	if !found || targetId == currentOf(meta, projects) {
		return nil, false
	}
	update = LiveUpdate(target)
	update[ProjectsMetaKey] = ListValue(projects)
	return update, true
}

func trimPath(path string) string {
	return strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(path), "\\", "/"), "/")
}

func holds(dir string, path string) bool {
	return path == dir || strings.HasPrefix(path, dir+"/")
}

// ProjectOfDir is the project whose folder holds dir: the longest match, with a "/" boundary, so Notulia does not
// hold Notulia-website. A project with a repository inside its folder matches by it too, which is longer: of several
// projects sharing a client's folder, the one whose repository holds dir owns it (#1777). "" when no project holds it.
// must match agentProjectLabel in frontend/moltenterm-shell/sidebar/sidebar-agents-model.ts
func ProjectOfDir(projects []Project, dir string) string {
	here := trimPath(dir)
	if here == "" {
		return ""
	}
	owner, ownerLen := "", -1
	for _, p := range projects {
		matched := matchLength(p, here)
		if matched > ownerLen {
			owner, ownerLen = p.Id, matched
		}
	}
	return owner
}

// matchLength is how much of dir a project's places hold: its repository first, else its folder; -1 for none.
func matchLength(p Project, here string) int {
	pd := trimPath(p.Dir)
	if pd == "" {
		return -1
	}
	if repo := trimPath(p.Repo); repo != "" && repo != pd && holds(pd, repo) && holds(repo, here) {
		return len(repo)
	}
	if holds(pd, here) {
		return len(pd)
	}
	return -1
}

// ReadTabProjects reads {tabId: projectId} from the workspace's meta.
func ReadTabProjects(meta waveobj.MetaMapType) map[string]string {
	return readStringMap(meta, TabProjectsMetaKey)
}

// ReadActiveByProject reads {projectId: tabId}, the view last shown in each project.
func ReadActiveByProject(meta waveobj.MetaMapType) map[string]string {
	return readStringMap(meta, ActiveByProjectMetaKey)
}

func readStringMap(meta waveobj.MetaMapType, key string) map[string]string {
	rtn := map[string]string{}
	switch raw := meta[key].(type) {
	case map[string]any:
		for k, v := range raw {
			if s, ok := v.(string); ok && k != "" && s != "" {
				rtn[k] = s
			}
		}
	case map[string]string:
		for k, v := range raw {
			if k != "" && v != "" {
				rtn[k] = v
			}
		}
	}
	return rtn
}

// ReadSlots reads {tabId: slot} from the workspace's meta.
func ReadSlots(meta waveobj.MetaMapType) map[string]string {
	return readStringMap(meta, SlotsMetaKey)
}

// PruneSlots drops the slots of the tabs that are gone.
func PruneSlots(tabIds []string, slots map[string]string) map[string]string {
	kept := map[string]string{}
	for tab, slot := range slots {
		if slices.Contains(tabIds, tab) {
			kept[tab] = slot
		}
	}
	return kept
}

// MapValue turns a string map into the value a meta stores; nil (the key leaves) when it is empty.
func MapValue(m map[string]string) any {
	if len(m) == 0 {
		return nil
	}
	rtn := make(map[string]any, len(m))
	for k, v := range m {
		rtn[k] = v
	}
	return rtn
}

// Belongs says whether a tab shows in a project: a tab outside the map, or mapped to a project the list no longer
// holds, belongs to every project.
func Belongs(tabProjects map[string]string, projects []Project, tabId string, projectId string) bool {
	owner := tabProjects[tabId]
	if owner == "" || owner == projectId {
		return true
	}
	_, known := FindProject(projects, owner)
	return !known
}

// ShownTabs is the workspace's tabs the project shows, in order; a workspace with one project shows them all.
func ShownTabs(tabIds []string, tabProjects map[string]string, projects []Project, projectId string) []string {
	if len(projects) < 2 || projectId == "" {
		return slices.Clone(tabIds)
	}
	rtn := make([]string, 0, len(tabIds))
	for _, id := range tabIds {
		if Belongs(tabProjects, projects, id, projectId) {
			rtn = append(rtn, id)
		}
	}
	return rtn
}

// OtherProjectTabs is the tabs another project owns: the ones a tab bar, the keys and the next active tab skip.
func OtherProjectTabs(tabIds []string, tabProjects map[string]string, projects []Project, projectId string) []string {
	if len(projects) < 2 || projectId == "" {
		return nil
	}
	var rtn []string
	for _, id := range tabIds {
		if !Belongs(tabProjects, projects, id, projectId) {
			rtn = append(rtn, id)
		}
	}
	return rtn
}

// Prune drops the tabs that are gone and the projects that are gone from the maps.
func Prune(tabIds []string, projects []Project, tabProjects map[string]string, active map[string]string) (map[string]string, map[string]string) {
	keptTabs := map[string]string{}
	for tab, project := range tabProjects {
		if _, ok := FindProject(projects, project); ok && slices.Contains(tabIds, tab) {
			keptTabs[tab] = project
		}
	}
	keptActive := map[string]string{}
	for project, tab := range active {
		if _, ok := FindProject(projects, project); ok && slices.Contains(tabIds, tab) {
			keptActive[project] = tab
		}
	}
	return keptTabs, keptActive
}
