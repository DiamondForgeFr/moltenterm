// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

func validateWith(t *testing.T, files map[string]string) PipelineReport {
	t.Helper()
	dir := t.TempDir()
	for rel, content := range files {
		writeProjectFile(t, dir, rel, content)
	}
	return ValidatePipeline(dir)
}

func hasMessage(list []string, part string) bool {
	for _, msg := range list {
		if strings.Contains(msg, part) {
			return true
		}
	}
	return false
}

const notuliaLikePipeline = `{
  "schema": 1,
  "name": "Notulia",
  "versions": {"tagprefix": "v", "notes": "releases/{tag}.md"},
  "ci": {"jobs": [
    {"name": "check", "title": "Checks", "lane": "a", "run": "bun run check"},
    {"name": "rust", "title": "Rust", "lane": "b", "run": "cargo clippy", "cwd": "src-tauri", "env": {"RUSTFLAGS": "-D warnings"}}
  ]},
  "builds": [{"id": "gold", "title": "Gold", "run": "./scripts/build-local.sh gold", "artifact": "~/Library/Application Support/Notulia Local Builds/gold"}],
  "release": {
    "rc": [{"id": "cut", "title": "Cut", "run": "./scripts/release.sh {version} --internal"}],
    "public": [{"id": "cut", "title": "Cut", "run": "./scripts/release.sh {version} --public"}]
  },
  "steps": [{"id": "verify-updater", "title": "Verify the updater", "section": "cd", "run": "bun scripts/verify.mjs --expect {tag}"}]
}`

func TestValidatePipelineAccepted(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json":    notuliaLikePipeline,
		"scripts/build-local.sh":  "#!/bin/sh",
		"scripts/release.sh":      "#!/bin/sh",
		"src-tauri/Cargo.toml":    "",
		"scripts/verify.mjs":      "",
		".saasfoundry.json":       `{"workflow": {}}`,
		"package.json":            "{}",
		"src-tauri/src/README.md": "",
	})
	if !report.Present || !report.Valid || len(report.Errors) != 0 {
		t.Fatalf("errors: %v", report.Errors)
	}
	if len(report.Pipeline.Ci.Jobs) != 2 || report.Pipeline.Builds[0].Artifact == "" {
		t.Fatalf("pipeline: %+v", report.Pipeline)
	}
}

func TestValidatePipelineAbsent(t *testing.T) {
	report := validateWith(t, nil)
	if report.Present || report.Valid {
		t.Fatalf("absent pipeline: %+v", report)
	}
}

func TestValidatePipelineErrors(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{
		  "schema": 2,
		  "branches": {"trunk": "develop"},
		  "versions": {"notes": "releases/notes.md"},
		  "ci": {"jobs": [
		    {"name": "check", "run": ""},
		    {"name": "check", "run": "make check", "cwd": "../elsewhere"},
		    {"name": "Bad Name", "run": "make {when}"}
		  ]},
		  "builds": [{"id": "gold", "run": "./scripts/missing.sh"}],
		  "steps": [{"id": "x", "section": "nowhere", "run": "true"}]
		}`,
		".saasfoundry.json": `{"workflow": {"workingBranch": "develop"}}`,
	})
	if report.Valid {
		t.Fatal("must be invalid")
	}
	for _, want := range []string{
		"schema must be 1",
		"name is required",
		"versions.notes must contain {tag}",
		"ci.jobs[0] (check): run is empty",
		`ci.jobs[1]: id "check" is used twice`,
		"leaves the project",
		`id "Bad Name"`,
		"unknown variable {when}",
		"./scripts/missing.sh does not exist",
		"title is required",
		`section "nowhere"`,
	} {
		if !hasMessage(report.Errors, want) {
			t.Errorf("missing error %q in %v", want, report.Errors)
		}
	}
	for _, want := range []string{".saasfoundry.json already declares them", "no artifact"} {
		if !hasMessage(report.Warnings, want) {
			t.Errorf("missing warning %q in %v", want, report.Warnings)
		}
	}
}

func TestValidatePipelineUnknownFieldAndBrokenJson(t *testing.T) {
	report := validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x", "ci": {"jobs": [{"name": "a", "run": "true", "command": "x"}]}}`})
	if report.Valid || !hasMessage(report.Errors, `unknown field "command"`) {
		t.Fatalf("unknown field: %v", report.Errors)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{broken`})
	if report.Valid || !report.Present || len(report.Errors) != 1 {
		t.Fatalf("broken JSON: %+v", report)
	}
}

func TestValidatePipelineEmpty(t *testing.T) {
	report := validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x"}`})
	if !report.Valid || !hasMessage(report.Warnings, "declares nothing to run") {
		t.Fatalf("empty pipeline: %+v", report)
	}
}

func TestReferencedScript(t *testing.T) {
	cases := map[string]string{
		"./scripts/build.sh gold":        "./scripts/build.sh",
		"bun scripts/local-ci.mjs run":   "scripts/local-ci.mjs",
		"npm run build":                  "",
		"FOO=1 ./x.sh":                   "./x.sh",
		"sh -c './scripts/$NAME.sh'":     "",
		"./scripts/release.sh {version}": "./scripts/release.sh",
		"go test ./cmd/... ./pkg/...":    "",
		"node scripts/a.mjs && node x":   "scripts/a.mjs",
		"npx eslint ./src":               "",
	}
	for run, want := range cases {
		if got := referencedScript(run); got != want {
			t.Errorf("referencedScript(%q) = %q, want %q", run, got, want)
		}
	}
}

func TestValidatePipelineIcon(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{"schema": 1, "name": "app", "icon": "build/app/icon.svg"}`,
		"build/app/icon.svg":   "<svg/>",
	})
	if !report.Valid || len(report.Errors) != 0 {
		t.Fatalf("a declared icon that exists is valid: %v", report.Errors)
	}
	for icon, want := range map[string]string{
		"build/app/missing.svg": "does not exist",
		"README.md":             "is not an image",
		"../outside.png":        "is outside the project",
	} {
		report := validateWith(t, map[string]string{
			".molten/project.json": `{"schema": 1, "name": "app", "icon": "` + icon + `"}`,
			"README.md":            "# app",
		})
		if report.Valid || !strings.Contains(strings.Join(report.Errors, "\n"), want) {
			t.Errorf("icon %q: want %q, got %v", icon, want, report.Errors)
		}
	}
}
