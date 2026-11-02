// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package projectviews

import (
	"reflect"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func twoProjects() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		ProjectsMetaKey: []any{
			map[string]any{"id": "p1", "type": "Desktop", "dir": "/x/stale"},
			map[string]any{"id": "p2", "type": "Website", "dir": "/x/Notulia-website", "logo": "/x/Notulia-website/logo.svg"},
		},
		CurrentProjectMetaKey: "p1",
		LiveProjectMetaKey:    "/x/Notulia",
		LiveTypeMetaKey:       "Desktop",
	}
}

func TestReadProjectsTakesTheCurrentOnesFolderFromTheLiveKeys(t *testing.T) {
	got := ReadProjects(twoProjects())
	want := []Project{
		{Id: "p1", Type: "Desktop", Dir: "/x/Notulia"},
		{Id: "p2", Type: "Website", Dir: "/x/Notulia-website", Logo: "/x/Notulia-website/logo.svg"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projects %+v, want %+v", got, want)
	}
	if CurrentProjectId(twoProjects()) != "p1" || !Multi(twoProjects()) {
		t.Fatalf("current %q, multi %v", CurrentProjectId(twoProjects()), Multi(twoProjects()))
	}
}

func TestReadProjectsWithoutAListIsOneProjectFromTheLiveKeys(t *testing.T) {
	if got := ReadProjects(waveobj.MetaMapType{}); got != nil {
		t.Fatalf("no project: %+v", got)
	}
	meta := waveobj.MetaMapType{LiveProjectMetaKey: "/x/a", LiveTypeMetaKey: "SaaS"}
	got := ReadProjects(meta)
	if len(got) != 1 || got[0].Id != FirstProjectId || got[0].Dir != "/x/a" || Multi(meta) {
		t.Fatalf("one project, not multi: %+v", got)
	}
}

func TestCurrentProjectFallsBackToTheFirst(t *testing.T) {
	meta := twoProjects()
	meta[CurrentProjectMetaKey] = "gone"
	if got := CurrentProjectId(meta); got != "p1" {
		t.Fatalf("current %q", got)
	}
}

func TestSwitchMetaWritesTheListAndTheTargetsLiveKeys(t *testing.T) {
	meta := twoProjects()
	update, ok := SwitchMeta(meta, "p2")
	if !ok {
		t.Fatal("a switch to p2")
	}
	if update[CurrentProjectMetaKey] != "p2" || update[LiveProjectMetaKey] != "/x/Notulia-website" ||
		update[LiveFolderMetaKey] != "/x/Notulia-website" || update[LiveTypeMetaKey] != "Website" {
		t.Fatalf("live keys %+v", update)
	}
	list, _ := update[ProjectsMetaKey].([]any)
	first, _ := list[0].(map[string]any)
	if first["dir"] != "/x/Notulia" {
		t.Fatalf("the project left keeps its live folder in the list: %+v", list)
	}
	if _, ok := SwitchMeta(meta, "p1"); ok {
		t.Fatal("already current")
	}
	if _, ok := SwitchMeta(meta, "p9"); ok {
		t.Fatal("unknown project")
	}
}

func TestProjectOfDir(t *testing.T) {
	projects := []Project{
		{Id: "p1", Dir: "/x/Notulia"},
		{Id: "p2", Dir: "/x/Notulia-website"},
		{Id: "p3", Dir: "/x/Notulia/apps/mobile/"},
	}
	cases := []struct {
		dir  string
		want string
	}{
		{"/x/Notulia", "p1"},
		{"/x/Notulia/src", "p1"},
		{"/x/Notulia-website", "p2"},
		{"/x/Notulia-website/pages/", "p2"},
		{"/x/Notulia/apps/mobile/ios", "p3"},
		{"/x/Notulia/apps", "p1"},
		{"/x/Notulia2", ""},
		{"/y/Notulia", ""},
		{"", ""},
		{"C:\\x\\Notulia", ""},
	}
	for _, c := range cases {
		if got := ProjectOfDir(projects, c.dir); got != c.want {
			t.Errorf("%q: %q, want %q", c.dir, got, c.want)
		}
	}
	if got := ProjectOfDir([]Project{{Id: "w", Dir: "C:\\x\\Notulia\\"}}, "C:/x/Notulia/src"); got != "w" {
		t.Errorf("separators are alike: %q", got)
	}
}

// #1777: projects of one client share its folder and differ by their repository; the live keys carry the current
// project's repository, and a pane belongs to the project whose repository holds it.
func clientProjects() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		ProjectsMetaKey: []any{
			map[string]any{"id": "p1", "type": "Web", "dir": "/c/ofpis", "repo": "/c/ofpis/app"},
			map[string]any{"id": "p2", "type": "API", "dir": "/c/ofpis", "repo": "/c/ofpis/api"},
			map[string]any{"id": "p3", "type": "Docs", "dir": "/c/ofpis"},
		},
		CurrentProjectMetaKey: "p1",
		LiveProjectMetaKey:    "/c/ofpis",
		LiveRepoMetaKey:       "/c/ofpis/app",
		LiveTypeMetaKey:       "Web",
	}
}

func TestProjectsKeepTheirRepository(t *testing.T) {
	got := ReadProjects(clientProjects())
	want := []Project{
		{Id: "p1", Type: "Web", Dir: "/c/ofpis", Repo: "/c/ofpis/app"},
		{Id: "p2", Type: "API", Dir: "/c/ofpis", Repo: "/c/ofpis/api"},
		{Id: "p3", Type: "Docs", Dir: "/c/ofpis"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projects %+v, want %+v", got, want)
	}
	meta := clientProjects()
	meta[LiveRepoMetaKey] = "/c/ofpis/other"
	if got := ReadProjects(meta)[0].Repo; got != "/c/ofpis/other" {
		t.Errorf("the current project's repository comes from the live key: %q", got)
	}
	delete(meta, LiveRepoMetaKey)
	if got := ReadProjects(meta)[0].Repo; got != "" {
		t.Errorf("without the live key the current project has none: %q", got)
	}
	one := ReadProjects(waveobj.MetaMapType{LiveProjectMetaKey: "/c/ofpis", LiveRepoMetaKey: "/c/ofpis/app"})
	if len(one) != 1 || one[0].Repo != "/c/ofpis/app" {
		t.Errorf("a workspace without a list: %+v", one)
	}
}

func TestSwitchMetaCarriesTheRepository(t *testing.T) {
	update, ok := SwitchMeta(clientProjects(), "p2")
	if !ok || update[LiveRepoMetaKey] != "/c/ofpis/api" {
		t.Fatalf("a switch to p2 makes its repository the live one: %+v", update)
	}
	list, _ := update[ProjectsMetaKey].([]any)
	first, _ := list[0].(map[string]any)
	if first["repo"] != "/c/ofpis/app" {
		t.Errorf("the project left keeps its repository in the list: %+v", list)
	}
	third, _ := list[2].(map[string]any)
	if _, has := third["repo"]; has {
		t.Errorf("a project without a repository writes no key: %+v", third)
	}
	update, ok = SwitchMeta(clientProjects(), "p3")
	if !ok {
		t.Fatal("a switch to p3")
	}
	if value, present := update[LiveRepoMetaKey]; !present || value != nil {
		t.Errorf("a project without one clears the live key: %+v", update)
	}
}

func TestProjectOfDirPrefersTheProjectWhoseRepositoryHoldsIt(t *testing.T) {
	projects := ReadProjects(clientProjects())
	cases := []struct {
		dir  string
		want string
	}{
		{"/c/ofpis/app", "p1"},
		{"/c/ofpis/app/src", "p1"},
		{"/c/ofpis/api/src", "p2"},
		{"/c/ofpis/docs", "p1"},
		{"/c/ofpis", "p1"},
		{"/c/ofpis/application", "p1"},
	}
	for _, c := range cases {
		if got := ProjectOfDir(projects, c.dir); got != c.want {
			t.Errorf("%q: %q, want %q", c.dir, got, c.want)
		}
	}
	docs := []Project{{Id: "d", Dir: "/c/ofpis"}, {Id: "w", Dir: "/c/ofpis", Repo: "/c/ofpis/app"}}
	if got := ProjectOfDir(docs, "/c/ofpis/app/x"); got != "w" {
		t.Errorf("a repository beats the folder alone: %q", got)
	}
	if got := ProjectOfDir([]Project{{Id: "w", Dir: "/c/ofpis", Repo: "/elsewhere/app"}}, "/elsewhere/app/x"); got != "" {
		t.Errorf("a repository outside the folder is ignored: %q", got)
	}
}

func TestShownTabsFiltersByProjectAndSharesTheUnmapped(t *testing.T) {
	projects := []Project{{Id: "p1"}, {Id: "p2"}}
	tabs := []string{"project", "a1", "b1", "a2", "orphan"}
	owners := map[string]string{"a1": "p1", "a2": "p1", "b1": "p2", "orphan": "p9"}
	if got := ShownTabs(tabs, owners, projects, "p1"); !slices.Equal(got, []string{"project", "a1", "a2", "orphan"}) {
		t.Errorf("p1 shows %v", got)
	}
	if got := ShownTabs(tabs, owners, projects, "p2"); !slices.Equal(got, []string{"project", "b1", "orphan"}) {
		t.Errorf("p2 shows %v", got)
	}
	if got := OtherProjectTabs(tabs, owners, projects, "p2"); !slices.Equal(got, []string{"a1", "a2"}) {
		t.Errorf("others %v", got)
	}
}

func TestOneProjectShowsEveryTab(t *testing.T) {
	tabs := []string{"a", "b"}
	owners := map[string]string{"a": "p1", "b": "p2"}
	if got := ShownTabs(tabs, owners, []Project{{Id: "p1"}}, "p1"); !slices.Equal(got, tabs) {
		t.Errorf("one project: %v", got)
	}
	if got := ShownTabs(tabs, owners, nil, ""); !slices.Equal(got, tabs) {
		t.Errorf("no project: %v", got)
	}
	if got := OtherProjectTabs(tabs, owners, []Project{{Id: "p1"}}, "p1"); got != nil {
		t.Errorf("one project hides nothing: %v", got)
	}
}

func TestMapsRoundTripThroughTheMeta(t *testing.T) {
	meta := waveobj.MetaMapType{
		TabProjectsMetaKey:     map[string]any{"a": "p1", "b": "", "": "p2", "c": 3},
		ActiveByProjectMetaKey: map[string]string{"p1": "a"},
	}
	if got := ReadTabProjects(meta); !reflect.DeepEqual(got, map[string]string{"a": "p1"}) {
		t.Errorf("tab projects %v", got)
	}
	if got := ReadActiveByProject(meta); !reflect.DeepEqual(got, map[string]string{"p1": "a"}) {
		t.Errorf("active %v", got)
	}
	if MapValue(nil) != nil || MapValue(map[string]string{}) != nil {
		t.Errorf("an empty map leaves the meta")
	}
	if got, _ := MapValue(map[string]string{"a": "p1"}).(map[string]any); got["a"] != "p1" {
		t.Errorf("map value %v", got)
	}
}

func TestPruneDropsGoneTabsAndProjects(t *testing.T) {
	projects := []Project{{Id: "p1"}}
	tabs, active := Prune([]string{"a", "b"},
		projects,
		map[string]string{"a": "p1", "b": "p2", "c": "p1"},
		map[string]string{"p1": "a", "p2": "b", "p3": "z"})
	if !reflect.DeepEqual(tabs, map[string]string{"a": "p1"}) || !reflect.DeepEqual(active, map[string]string{"p1": "a"}) {
		t.Errorf("tabs %v, active %v", tabs, active)
	}
}
