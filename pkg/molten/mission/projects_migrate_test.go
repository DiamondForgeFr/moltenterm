// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"reflect"
	"strings"
	"testing"
)

func TestProjectTypeFromName(t *testing.T) {
	cases := map[[2]string]string{
		{"Notulia Mobile", "Notulia"}:     "Mobile",
		{"notulia - Site web", "Notulia"}: "Site web",
		{"NotuliaMobile", "Notulia"}:      "NotuliaMobile",
		{"Shop", "Notulia"}:               "Shop",
		{"Notulia", "Notulia"}:            "Notulia",
	}
	for in, want := range cases {
		if got := projectTypeFromName(in[0], in[1]); got != want {
			t.Errorf("projectTypeFromName(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestPlanProjectsMigration(t *testing.T) {
	workspaces := map[string]MigrateWorkspace{
		"a": {Id: "a", Name: "Notulia", Dir: "/p/notulia", Type: "Desktop"},
		"b": {Id: "b", Name: "Notulia Mobile", Dir: "/p/notulia-mobile"},
		"c": {Id: "c", Name: "Notes", Dir: ""},
		"d": {Id: "d", Name: "Site", Dir: "/p/site", Type: "Website"},
		"e": {Id: "e", Name: "Scratch", Dir: ""},
		"f": {Id: "f", Name: "Fresh", Dir: "/p/fresh", HasList: true},
		"g": {Id: "g", Name: "Other", Dir: "/p/other"},
		"h": {Id: "h", Name: "Same", Dir: "/p/notulia/"},
	}
	plans := PlanProjectsMigration(workspaces, []MigrateGroup{
		{Name: "Notulia", Members: []string{"a", "b", "c", "d", "h"}},
		{Name: "Loose", Members: []string{"e", "c"}},
		{Name: "Chosen", Members: []string{"f", "g"}},
		{Name: "Ghost", Members: []string{"zz", "a"}},
		{Name: "Folderless first", Members: []string{"e", "g"}},
	})
	if len(plans) != 2 {
		t.Fatalf("got %d plans, want 2: %+v", len(plans), plans)
	}
	notulia := plans[0]
	if notulia.HostId != "a" {
		t.Fatalf("host = %q, want a", notulia.HostId)
	}
	want := []WorkspaceProject{
		{Id: "p1", Type: "Desktop", Dir: "/p/notulia"},
		{Id: "p2", Type: "Mobile", Dir: "/p/notulia-mobile"},
		{Id: "p3", Type: "Website", Dir: "/p/site"},
	}
	if !reflect.DeepEqual(notulia.Projects, want) {
		t.Errorf("projects = %+v, want %+v", notulia.Projects, want)
	}
	if !reflect.DeepEqual(notulia.Moved, []string{"Notulia Mobile", "Site"}) || !reflect.DeepEqual(notulia.Kept, []string{"Notes"}) {
		t.Errorf("moved %v kept %v", notulia.Moved, notulia.Kept)
	}
	// The first member without a folder hands the host to the next one.
	if plans[1].HostId != "g" || !reflect.DeepEqual(plans[1].Kept, []string{"Scratch"}) || len(plans[1].Moved) != 0 {
		t.Errorf("folderless first plan = %+v", plans[1])
	}
}

func TestProjectsMigrationNotice(t *testing.T) {
	plan := MigratePlan{HostId: "a", HostName: "Notulia", GroupName: "Notulia",
		Projects: []WorkspaceProject{{Id: "p1", Dir: "/p/notulia"}, {Id: "p2", Type: "Mobile", Dir: "/p/m"}},
		Moved:    []string{"Notulia Mobile"}}
	input := projectsMigrationNotice(plan)
	if input.TitleText.Code != "notif.projects.migratedTitle" || input.MessageText.Code != "notif.projects.migrated" {
		t.Errorf("codes = %q %q", input.TitleText.Code, input.MessageText.Code)
	}
	if input.MessageText.Vars["projects"] != "notulia, Mobile" || !strings.Contains(input.Message, "Notulia Mobile") {
		t.Errorf("message = %q vars %v", input.Message, input.MessageText.Vars)
	}
	plan.Kept = []string{"Notes"}
	if projectsMigrationNotice(plan).MessageText.Code != "notif.projects.migratedKept" {
		t.Errorf("kept code missing")
	}
	plan.Moved = nil
	if projectsMigrationNotice(plan).MessageText.Code != "notif.projects.kept" {
		t.Errorf("kept-only code missing")
	}
}
