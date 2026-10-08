// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestMoltenRailRouting(t *testing.T) {
	cases := map[string]string{
		"molten rail group list --json":      "list",
		"molten rail group add A --to B":     "add",
		"molten rail group remove A":         "remove",
		"molten rail group rename g Clients": "rename",
		"molten rail group ungroup Clients":  "ungroup",
		"molten rail group":                  "group",
		"molten rail":                        "rail",
	}
	for line, want := range cases {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if found.Name() != want {
			t.Errorf("%q routes to %q, want %q", line, found.Name(), want)
		}
	}
}

var moltenRailTestList = MoltenRailList{
	Workspaces: []moltenRailWorkspace{
		{Id: "a", Name: "A"}, {Id: "b", Name: "B", Group: "g"}, {Id: "d", Name: "D", Group: "g"},
		{Id: "x1", Name: "Twin"}, {Id: "x2", Name: "twin"},
		{Id: "app", Name: "App", Product: "Notulia"}, {Id: "site", Name: "Site", Product: "Notulia"},
	},
	Groups: []moltenRailGroup{{Id: "g", Name: "Clients", Renamed: true, Members: []string{"b", "d"}}},
}

func TestMoltenRailFind(t *testing.T) {
	if ws, err := moltenRailFindWorkspace(moltenRailTestList, " a "); err != nil || ws.Id != "a" {
		t.Fatalf("by name, case ignored: %v, %v", ws, err)
	}
	if ws, err := moltenRailFindWorkspace(moltenRailTestList, "x2"); err != nil || ws.Id != "x2" {
		t.Fatalf("by id: %v, %v", ws, err)
	}
	if _, err := moltenRailFindWorkspace(moltenRailTestList, "twin"); err == nil || !strings.Contains(err.Error(), "2 workspaces") {
		t.Fatalf("shared name: %v", err)
	}
	if id, err := moltenRailFindTarget(moltenRailTestList, "clients"); err != nil || id != "g" {
		t.Fatalf("a group as target: %v, %v", id, err)
	}
	if id, err := moltenRailFindTarget(moltenRailTestList, "B"); err != nil || id != "b" {
		t.Fatalf("a workspace as target: %v, %v", id, err)
	}
	if _, err := moltenRailFindTarget(moltenRailTestList, "nothing"); err == nil || !strings.Contains(err.Error(), "no saved workspace or group") {
		t.Fatalf("unknown target: %v", err)
	}
	if _, err := moltenRailFindTarget(moltenRailTestList, "twin"); err == nil || !strings.Contains(err.Error(), "2 workspaces") {
		t.Fatalf("an ambiguous target is not taken for a group: %v", err)
	}
	if moltenRailGroupNameOf(moltenRailTestList, "d") != "Clients" || moltenRailGroupNameOf(moltenRailTestList, "a") != "(none)" {
		t.Fatalf("group of a workspace")
	}
}

func TestFormatMoltenRailList(t *testing.T) {
	out := formatMoltenRailList(moltenRailTestList)
	if !strings.Contains(out, "Clients: B, D\n") {
		t.Fatalf("group line missing:\n%s", out)
	}
	if !strings.Contains(out, "project groups (declared in their projects, not changed here): Notulia\n") {
		t.Fatalf("project groups line missing:\n%s", out)
	}
	unnamed := formatMoltenRailList(MoltenRailList{
		Workspaces: []moltenRailWorkspace{{Id: "b", Name: "B"}, {Id: "d", Name: "D"}},
		Groups:     []moltenRailGroup{{Id: "g", Name: "B", Members: []string{"b", "d"}}},
	})
	if !strings.Contains(unnamed, "B (named after its first workspace): B, D") {
		t.Fatalf("default name:\n%s", unnamed)
	}
	if empty := formatMoltenRailList(MoltenRailList{}); !strings.Contains(empty, "no groups in the rail") {
		t.Fatalf("empty:\n%s", empty)
	}
}
