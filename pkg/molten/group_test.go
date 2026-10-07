// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGroupNameAndKey(t *testing.T) {
	if name, err := GroupName("  Notulia "); err != nil || name != "Notulia" {
		t.Fatalf("trimmed name: %q, %v", name, err)
	}
	if GroupKey(" NOTULIA") != GroupKey("notulia  ") || GroupKey("Notulia") != "notulia" {
		t.Fatal("group names must match after trimming, ignoring case")
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 65), "a\nb"} {
		if _, err := GroupName(bad); err == nil {
			t.Errorf("%q must not be a group name", bad)
		}
		if GroupKey(bad) != "" {
			t.Errorf("%q must give no key", bad)
		}
	}
	if _, err := GroupName(strings.Repeat("é", 64)); err != nil {
		t.Fatalf("64 characters are allowed, whatever their bytes: %v", err)
	}
	if !SameProjectName(" Notulia", "notulia") || SameProjectName("", "") || SameProjectName("a", "b") {
		t.Fatal("SameProjectName")
	}
}

type fakeProjects map[string]ProjectInfo

func (f fakeProjects) read(dir string) ProjectInfo {
	if info, ok := f[dir]; ok {
		return info
	}
	return ProjectInfo{Dir: dir, Name: filepath.Base(dir)}
}

func member(dir string, name string, group string) ProjectInfo {
	return ProjectInfo{Dir: dir, Name: name, Exists: true, GitRoot: dir, HasPipeline: true, Group: group}
}

func TestResolveGroups(t *testing.T) {
	projects := fakeProjects{
		"/p/site":     member("/p/site", "notulia-website", " notulia "),
		"/p/app":      member("/p/app", "Notulia", "Notulia"),
		"/p/molten":   member("/p/molten", "MoltenTerm", ""),
		"/p/releases": member("/p/releases", "notulia-releases", "NOTULIA"),
		"/p/other":    member("/p/other", "Other", "Other"),
	}
	links := []GroupLink{
		{WorkspaceId: "w-site", WorkspaceName: "Site", Dir: "/p/site"},
		{WorkspaceId: "w-molten", WorkspaceName: "MoltenTerm", Dir: "/p/molten"},
		{WorkspaceId: "w-app", WorkspaceName: "App", Dir: "/p/app"},
		{WorkspaceId: "w-app2", WorkspaceName: "App review", Dir: "/p/app/"},
		{WorkspaceId: "w-other", WorkspaceName: "Other", Dir: "/p/other"},
		{WorkspaceId: "w-none", Dir: ""},
	}
	groups := ResolveGroups(links, projects.read)
	if len(groups) != 2 {
		t.Fatalf("groups: %+v", groups)
	}
	notulia := groups[0]
	if notulia.Key != "notulia" || notulia.Name != "notulia" {
		t.Fatalf("the name shown is the first member's spelling in rail order: %+v", notulia)
	}
	if len(notulia.Members) != 2 || notulia.Members[0].Dir != "/p/site" || notulia.Members[1].Dir != "/p/app" {
		t.Fatalf("members in rail order, the unlinked releases repository left out: %+v", notulia.Members)
	}
	app := notulia.Members[1]
	if len(app.Workspaces) != 2 || app.Workspaces[0].Id != "w-app" || app.Workspaces[1].Name != "App review" {
		t.Fatalf("a project linked twice counts once, with both workspaces: %+v", app)
	}
	if groups[1].Name != "Other" || len(groups[1].Members) != 1 {
		t.Fatalf("a group of one member is still a group: %+v", groups[1])
	}
	if FindGroup(groups, "/p/app/") != &groups[0] || FindGroup(groups, "/p/molten") != nil || FindGroup(groups, "") != nil {
		t.Fatal("FindGroup")
	}
}

func TestResolveGroupsAfterRemoval(t *testing.T) {
	projects := fakeProjects{
		"/p/app":  member("/p/app", "Notulia", "Notulia"),
		"/p/site": member("/p/site", "notulia-website", "Notulia"),
	}
	links := []GroupLink{{WorkspaceId: "a", Dir: "/p/app"}, {WorkspaceId: "s", Dir: "/p/site"}}
	if groups := ResolveGroups(links, projects.read); len(groups) != 1 || len(groups[0].Members) != 2 {
		t.Fatalf("before: %+v", groups)
	}
	projects["/p/site"] = member("/p/site", "notulia-website", "")
	groups := ResolveGroups(links, projects.read)
	if len(groups) != 1 || len(groups[0].Members) != 1 || groups[0].Members[0].Dir != "/p/app" {
		t.Fatalf("after the site removed its group: %+v", groups)
	}
}

// A project file below another member's root is never read as a member: each repository is read from its own root.
func TestResolveGroupsReadsEachRepositoryAtItsRoot(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app")
	if err := os.MkdirAll(filepath.Join(app, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	writeProjectFile(t, app, ProjectPipelineFile, `{"schema": 1, "name": "Notulia", "group": "Notulia"}`)
	nested := filepath.Join(app, "website")
	writeProjectFile(t, nested, ProjectPipelineFile, `{"schema": 1, "name": "site", "group": "Notulia"}`)
	plain := filepath.Join(root, "plain")
	writeProjectFile(t, plain, ProjectPipelineFile, `{"schema": 1, "name": "plain", "group": "Notulia"}`)
	links := []GroupLink{{WorkspaceId: "a", Dir: app}, {WorkspaceId: "n", Dir: nested}, {WorkspaceId: "p", Dir: plain}}
	groups := ResolveGroups(links, ReadProject)
	if len(groups) != 1 || len(groups[0].Members) != 2 || groups[0].Members[0].Dir != app || groups[0].Members[1].Dir != plain {
		t.Fatalf("the folder below the app's root must not be a member: %+v", groups)
	}
}

func TestReadProjectGroup(t *testing.T) {
	dir := t.TempDir()
	writeProjectFile(t, dir, ProjectPipelineFile, `{"schema": 1, "name": "Notulia", "group": "  Notulia ", "ci": {"jobs": []}}`)
	if info := ReadProject(dir); info.Group != "Notulia" {
		t.Fatalf("group read even when another part of the pipeline has a mistake: %+v", info)
	}
	writeProjectFile(t, dir, ProjectPipelineFile, `{"schema": 1, "name": "Notulia", "group": "`+strings.Repeat("x", 65)+`"}`)
	if info := ReadProject(dir); info.Group != "" {
		t.Fatalf("an invalid group name is no group: %+v", info)
	}
	writeProjectFile(t, dir, ProjectPipelineFile, `{"schema": 1, "name": "Notulia"}`)
	if info := ReadProject(dir); info.Group != "" {
		t.Fatalf("no group: %+v", info)
	}
}
