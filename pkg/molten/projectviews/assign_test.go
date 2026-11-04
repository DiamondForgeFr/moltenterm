// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package projectviews

import (
	"reflect"
	"testing"
)

// The gold's Notulia workspace: Desktop is Notulia, the website is Notulia-website, and their names share a prefix.
var notulia = []Project{
	{Id: "p1", Type: "Desktop", Dir: "/x/Notulia"},
	{Id: "p2", Type: "Website", Dir: "/x/Notulia-website"},
}

func term(dir string) PaneFact  { return PaneFact{Dir: dir} }
func agent(dir string) PaneFact { return PaneFact{Dir: dir, Agent: true} }

func TestAssignTab(t *testing.T) {
	cases := []struct {
		name  string
		facts TabFacts
		want  string
	}{
		{"terminals in Desktop", TabFacts{Id: "t", Panes: []PaneFact{term("/x/Notulia"), term("/x/Notulia/src")}}, "p1"},
		{"terminal in the website", TabFacts{Id: "t", Panes: []PaneFact{term("/x/Notulia-website")}}, "p2"},
		{"the first agent wins over the majority", TabFacts{Id: "t", Panes: []PaneFact{
			term("/x/Notulia"), term("/x/Notulia"), agent("/x/Notulia-website")}}, "p2"},
		{"the first agent with a folder in a project", TabFacts{Id: "t", Panes: []PaneFact{
			agent("/elsewhere"), agent("/x/Notulia"), agent("/x/Notulia-website")}}, "p1"},
		{"the majority", TabFacts{Id: "t", Panes: []PaneFact{
			term("/x/Notulia-website"), term("/x/Notulia"), term("/x/Notulia-website")}}, "p2"},
		{"a tie goes to the first panel", TabFacts{Id: "t", Panes: []PaneFact{term("/x/Notulia-website"), term("/x/Notulia")}}, "p2"},
		{"a file panel counts", TabFacts{Id: "t", Panes: []PaneFact{{Dir: "/x/Notulia-website/README.md"}}}, "p2"},
		{"an agent folder outside every project", TabFacts{Id: "t", Panes: []PaneFact{agent("/tmp/scratch")}}, ""},
		{"no panel", TabFacts{Id: "t"}, ""},
		{"the Project tab is shared", TabFacts{Id: "t", ProjectTab: true, Panes: []PaneFact{term("/x/Notulia")}}, ""},
	}
	for _, c := range cases {
		if got := AssignTab(notulia, c.facts); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAssignGivesEveryUnmappedViewAProjectAndTouchesNothingElse(t *testing.T) {
	unmapped := []TabFacts{
		{Id: "project", ProjectTab: true},
		{Id: "desktop", Panes: []PaneFact{agent("/x/Notulia")}},
		{Id: "cadrage", Panes: []PaneFact{agent("/x/Notulia-website"), term("/x/Notulia-website")}},
		{Id: "lost", Panes: []PaneFact{term("/tmp")}},
		{Id: "done", Panes: []PaneFact{term("/x/Notulia")}},
	}
	mapped := map[string]string{"done": "p2"}
	got := Assign(notulia, mapped, unmapped, "p2")
	want := map[string]string{"desktop": "p1", "cadrage": "p2", "lost": "p2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("assigned %v, want %v", got, want)
	}
	if mapped["done"] != "p2" || len(mapped) != 1 {
		t.Fatalf("the map is read, never written: %v", mapped)
	}
}

func TestAssignFallsBackToTheFirstProjectWhenTheFallbackIsUnknown(t *testing.T) {
	got := Assign(notulia, nil, []TabFacts{{Id: "lost"}}, "gone")
	if got["lost"] != "p1" {
		t.Fatalf("assigned %v", got)
	}
}

func TestAssignDoesNothingForOneProject(t *testing.T) {
	if got := Assign(notulia[:1], nil, []TabFacts{{Id: "a"}}, "p1"); len(got) != 0 {
		t.Fatalf("a workspace with one project maps nothing: %v", got)
	}
}
