// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Project groups (FR-MC-026, DS-MC-017): a product made of several repositories is the set of projects linked to
// MoltenTerm workspaces whose `.molten/project.json` declares the same `group`. There is no group file and MoltenTerm
// writes nothing in any project: each member declares itself, and leaves the group by removing the field.
//
// Resolution is pure: the caller passes the workspace links in rail order and how to read a project, so the rail
// (#348), the group strip (#349) and the dependencies (#350) all see the same groups.

const GroupNameMaxLength = 64

// GroupName returns the group name a project wrote, trimmed, or why it is not one.
func GroupName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("must not be empty (leave the field out for no group)")
	}
	if utf8.RuneCountInString(name) > GroupNameMaxLength {
		return "", fmt.Errorf("must be at most %d characters (got %d)", GroupNameMaxLength, utf8.RuneCountInString(name))
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("must not hold a control character")
		}
	}
	return name, nil
}

// GroupKey is what members' group names are matched on: trimmed, ignoring case. It is empty for a name that is not
// valid, which puts the project in no group.
func GroupKey(raw string) string {
	name, err := GroupName(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(name)
}

// SameProjectName compares pipeline names the way group names are compared (trimmed, ignoring case): a dependency's
// `project` names a member this way.
func SameProjectName(a string, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	return a != "" && strings.EqualFold(a, b)
}

// A workspace's link to its project folder (the workspace meta molten:project), as the rail orders workspaces.
type GroupLink struct {
	WorkspaceId   string `json:"workspaceid"`
	WorkspaceName string `json:"workspacename,omitempty"`
	Dir           string `json:"dir"`
}

type GroupWorkspace struct {
	Id   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type GroupMember struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
	// The group name as this member wrote it, trimmed.
	Group string `json:"group"`
	// The workspaces linked to it, in rail order; the first one is where the member is opened.
	Workspaces []GroupWorkspace `json:"workspaces"`
}

type ProjectGroup struct {
	// The trimmed, lowercased name: stable whatever spelling each member uses, so client state (a collapsed product)
	// is keyed by it.
	Key string `json:"key"`
	// The spelling of the first member in rail order.
	Name string `json:"name"`
	// In the rail order of each member's first linked workspace. A group of one member is still a group; the rail
	// shows it as an ordinary workspace (FR-MC-027).
	Members []GroupMember `json:"members"`
}

// memberOfOwnRoot tells whether a linked folder is read as a project: a folder below another repository's root is not
// one of its own, so a `.molten/project.json` there is never a member (each repository is read from its root only).
func memberOfOwnRoot(dir string, info ProjectInfo) bool {
	return info.Exists && (info.GitRoot == "" || filepath.Clean(info.GitRoot) == dir)
}

// ResolveGroups builds the groups from the workspace links, in rail order, reading each linked project once. Only
// linked projects are members: a repository declaring a group but linked to no workspace is not part of it.
func ResolveGroups(links []GroupLink, read func(dir string) ProjectInfo) []ProjectGroup {
	groups := []ProjectGroup{}
	groupIndex := map[string]int{}
	type memberRef struct{ group, member int }
	members := map[string]memberRef{}
	skipped := map[string]bool{}
	for _, link := range links {
		if link.Dir == "" || !filepath.IsAbs(link.Dir) {
			continue
		}
		dir := filepath.Clean(link.Dir)
		workspace := GroupWorkspace{Id: link.WorkspaceId, Name: link.WorkspaceName}
		if ref, ok := members[dir]; ok {
			member := &groups[ref.group].Members[ref.member]
			member.Workspaces = append(member.Workspaces, workspace)
			continue
		}
		if skipped[dir] {
			continue
		}
		info := read(dir)
		key := GroupKey(info.Group)
		if key == "" || !memberOfOwnRoot(dir, info) {
			skipped[dir] = true
			continue
		}
		index, ok := groupIndex[key]
		if !ok {
			index = len(groups)
			groupIndex[key] = index
			groups = append(groups, ProjectGroup{Key: key, Name: strings.TrimSpace(info.Group), Members: []GroupMember{}})
		}
		members[dir] = memberRef{group: index, member: len(groups[index].Members)}
		groups[index].Members = append(groups[index].Members, GroupMember{
			Dir:        dir,
			Name:       info.Name,
			Group:      strings.TrimSpace(info.Group),
			Workspaces: []GroupWorkspace{workspace},
		})
	}
	return groups
}

// FindGroup returns the group a project folder is a member of, or nil.
func FindGroup(groups []ProjectGroup, dir string) *ProjectGroup {
	if dir == "" {
		return nil
	}
	dir = filepath.Clean(dir)
	for i := range groups {
		for _, member := range groups[i].Members {
			if member.Dir == dir {
				return &groups[i]
			}
		}
	}
	return nil
}
