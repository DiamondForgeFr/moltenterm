// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

func TestValidatePipelineGroupAndDependencies(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{
		  "schema": 1,
		  "name": "notulia-website",
		  "group": " Notulia ",
		  "dependson": [{
		    "project": "Notulia",
		    "paths": ["features/*.json"],
		    "branch": "develop",
		    "sync": "node scripts/sync-features.mjs",
		    "output": ["src/data/features.json", "src/data/plans/**"]
		  }],
		  "builds": [{"id": "site", "run": "npm run build", "artifact": "dist"}]
		}`,
		"scripts/sync-features.mjs": "",
	})
	if !report.Valid || len(report.Errors) != 0 {
		t.Fatalf("errors: %v", report.Errors)
	}
	if report.Pipeline.Schema != PipelineSchema || report.Pipeline.Group != " Notulia " || len(report.Pipeline.DependsOn) != 1 {
		t.Fatalf("pipeline: %+v", report.Pipeline)
	}
}

func TestValidatePipelineGroupErrors(t *testing.T) {
	for _, group := range []string{`""`, `"   "`, `"` + strings.Repeat("x", 65) + `"`, `"a\tb"`} {
		report := validateWith(t, map[string]string{
			".molten/project.json": `{"schema": 1, "name": "site", "group": ` + group + `, "steps": [{"id": "a", "title": "A", "section": "cd", "run": "true"}]}`,
		})
		if report.Valid || !hasMessage(report.Errors, "group:") {
			t.Errorf("group %s: %v", group, report.Errors)
		}
	}
	report := validateWith(t, map[string]string{
		".molten/project.json": `{"schema": 1, "name": "site", "group": 3}`,
	})
	if report.Valid {
		t.Fatal("a group that is not a string must be refused")
	}
}

func TestValidatePipelineDependencyErrors(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{
		  "schema": 1,
		  "name": "site",
		  "dependson": [
		    {"project": "Notulia", "paths": ["features/*.json"]},
		    {"project": "Notulia", "output": ["src/data/x.json"]},
		    {"paths": ["a"], "output": ["b"]},
		    {"project": "SITE", "paths": ["a"], "output": ["b"]},
		    {"project": "Notulia", "paths": ["../Notulia/features/*.json", "/abs", "[x", ":(top)x"], "output": ["out", ""], "branch": "-x", "sync": "./scripts/missing.sh"}
		  ],
		  "steps": [{"id": "a", "title": "A", "section": "cd", "run": "true"}]
		}`,
	})
	if report.Valid {
		t.Fatal("incomplete dependencies must be refused")
	}
	for _, want := range []string{
		"dependson[0] (Notulia): output is required",
		"dependson[1] (Notulia): paths is required",
		"dependson[2]: project is required",
		"dependson[3] (SITE): project names this project itself",
		`paths glob "../Notulia/features/*.json" must not use ..`,
		`paths glob "/abs" must be relative`,
		`paths glob "[x" is not a valid glob`,
		`paths glob ":(top)x" must be a plain path or glob`,
		"output holds an empty glob",
		`branch "-x" is not a branch name`,
		"./scripts/missing.sh does not exist",
	} {
		if !hasMessage(report.Errors, want) {
			t.Errorf("missing error %q in %v", want, report.Errors)
		}
	}
}

// A project without group or dependson is read exactly as before (FR-MC-026 AC6).
func TestValidatePipelineWithoutGroup(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{"schema": 1, "name": "site", "steps": [{"id": "a", "title": "A", "section": "cd", "run": "true"}]}`,
	})
	if !report.Valid || report.Pipeline.Group != "" || report.Pipeline.DependsOn != nil {
		t.Fatalf("report: %+v", report)
	}
}
