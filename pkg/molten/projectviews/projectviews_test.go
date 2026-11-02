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
