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

func TestValidatePipelineStepEnvironments(t *testing.T) {
	report := validateWith(t, map[string]string{".molten/project.json": `{
	  "schema": 1, "name": "x",
	  "steps": [
	    {"id": "deploy-dev", "title": "Deploy to dev", "section": "cd", "environment": "dev", "run": "true"},
	    {"id": "deploy-prod", "title": "Deploy to prod", "section": "cd", "environment": "prod", "confirm": true, "run": "true", "env": {"TARGET": "prod"}}
	  ]
	}`})
	if !report.Valid || len(report.Errors) != 0 {
		t.Fatalf("errors: %v", report.Errors)
	}
	steps := report.Pipeline.Steps
	if steps[0].Environment != "dev" || steps[0].Confirm || steps[1].Environment != "prod" || !steps[1].Confirm || steps[1].Env["TARGET"] != "prod" {
		t.Fatalf("steps: %+v", steps)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{
	  "schema": 1, "name": "x",
	  "steps": [
	    {"id": "a", "title": "A", "section": "timeline", "environment": "dev", "run": "true"},
	    {"id": "b", "title": "B", "section": "cd", "environment": "Dev Env", "run": "true"},
	    {"id": "c", "title": "C", "section": "cd", "environment": "prod", "run": "true"},
	    {"id": "d", "title": "D", "section": "cd", "environment": "prod", "run": "true"},
	    {"id": "e", "title": "E", "section": "cd", "confirm": true, "run": "true"}
	  ]
	}`})
	for _, want := range []string{
		`steps[0] (a): environment is only for a "cd" step`,
		`steps[1] (b): environment "Dev Env" must be lowercase`,
		`steps[3] (d): environment "prod" is deployed by two steps`,
		"steps[4] (e): confirm needs an environment",
	} {
		if !hasMessage(report.Errors, want) {
			t.Errorf("missing error %q in %v", want, report.Errors)
		}
	}
	if len(report.Errors) != 4 {
		t.Errorf("errors: %v", report.Errors)
	}
}

func TestValidatePipelineLaunch(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{
	  "schema": 1, "name": "x",
	  "launch": {
	    "where": "worktree",
	    "prepare": [{"id": "install", "title": "Install", "run": "npm install"}, {"id": "migrate", "run": "npm run db:update:dev -w apps/api"}],
	    "servers": [{"id": "api", "run": "npm run dev", "cwd": "apps/api", "port": 3500}, {"id": "web", "run": "npm run dev", "cwd": "apps/web", "port": 5173}],
	    "url": "http://localhost:5173"
	  }
	}`,
		"apps/api/package.json": "{}",
		"apps/web/package.json": "{}",
	})
	if !report.Valid || len(report.Errors) != 0 || len(report.Warnings) != 0 {
		t.Fatalf("errors: %v, warnings: %v", report.Errors, report.Warnings)
	}
	launch := report.Pipeline.Launch
	if launch.Where != PipelineLaunchWhereWorktree || len(launch.Prepare) != 2 || launch.Servers[1].Port != 5173 || launch.Servers[0].Cwd != "apps/api" {
		t.Fatalf("launch: %+v", launch)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{
	  "schema": 1, "name": "x",
	  "launch": {
	    "where": "elsewhere",
	    "prepare": [{"id": "a", "run": ""}],
	    "servers": [{"id": "a", "run": "true", "port": 70000}, {"id": "b", "run": "true", "port": 80}, {"id": "c", "run": "true", "port": 80}],
	    "url": "localhost:5173"
	  }
	}`})
	for _, want := range []string{
		`launch.where must be "main" or "worktree"`,
		"launch.prepare[0] (a): run is empty",
		`launch.servers[0]: id "a" is used twice`,
		"port must be between 1 and 65535",
		"port 80 is declared twice",
		"launch.url must start with http://",
	} {
		if !hasMessage(report.Errors, want) {
			t.Errorf("missing error %q in %v", want, report.Errors)
		}
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x", "launch": {"servers": []}}`})
	if !hasMessage(report.Errors, "launch.servers is empty") {
		t.Errorf("empty servers: %v", report.Errors)
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

// MoltenTerm's own pipeline: valid, and its version files agree.
func TestOwnPipelineIsValid(t *testing.T) {
	report := ValidatePipeline("../..")
	if !report.Valid || len(report.Warnings) != 0 {
		t.Fatalf("errors %v, warnings %v", report.Errors, report.Warnings)
	}
	if v := report.Pipeline.Versions; v == nil || v.FirstPublic == "" || len(v.Files) == 0 {
		t.Fatalf("versions: %+v", v)
	}
}

// The release commands write the notes and pass the tag to git: neither may leave the project or read as an option.
func TestValidatePipelineReleasePaths(t *testing.T) {
	for _, versionsJson := range []string{
		`{"notes": "{tag}/../../../elsewhere.md"}`,
		`{"notes": "/tmp/{tag}.md"}`,
		`{"tagprefix": "--upload-pack=x"}`,
		`{"tagprefix": "v x"}`,
	} {
		report := validateWith(t, map[string]string{
			".molten/project.json": `{"schema": 1, "name": "x", "versions": ` + versionsJson + `, "ci": {"jobs": [{"name": "a", "run": "true"}]}}`,
		})
		if report.Valid {
			t.Errorf("%s was accepted", versionsJson)
		}
	}
	report := validateWith(t, map[string]string{
		".molten/project.json": `{"schema": 1, "name": "x", "versions": {"tagprefix": "release-", "notes": "docs/releases/{tag}.md"}, "ci": {"jobs": [{"name": "a", "run": "true"}]}}`,
	})
	if !report.Valid {
		t.Errorf("a prefix with a dash and a notes folder: %v", report.Errors)
	}
}

func TestValidatePipelineVersions(t *testing.T) {
	report := validateWith(t, map[string]string{
		".molten/project.json": `{
		  "schema": 1, "name": "x",
		  "versions": {"tagprefix": "v", "firstpublic": "1.0.0", "rcformat": "rcdot", "files": [
		    {"path": "package.json", "format": "json", "keys": [["version"]]},
		    {"path": "package-lock.json", "format": "json", "keys": [["version"], ["packages", "", "version"]]},
		    {"path": "Cargo.toml", "format": "regex", "pattern": "(?m)^version = \"([^\"]+)\""}
		  ]},
		  "ci": {"jobs": [{"name": "a", "run": "true"}]}
		}`,
		"package.json":      `{"version": "1.0.0-0"}`,
		"package-lock.json": `{"version": "1.0.0-0", "packages": {"": {"version": "1.0.0-0"}}}`,
		"Cargo.toml":        "version = \"0.9.0\"\n",
	})
	if !report.Valid {
		t.Fatalf("errors: %v", report.Errors)
	}
	if !hasMessage(report.Warnings, "versions.files[2] (Cargo.toml): says 0.9.0 while the project's version is 1.0.0-0") {
		t.Errorf("warnings: %v", report.Warnings)
	}
	if got := report.Pipeline.Versions.Files[1].Keys[1]; len(got) != 3 || got[1] != "" {
		t.Errorf("empty key lost: %q", got)
	}

	report = validateWith(t, map[string]string{
		".molten/project.json": `{
		  "schema": 1, "name": "x",
		  "versions": {"firstpublic": "1.0", "rcformat": "rc.N", "files": [
		    {"path": "package.json", "format": "json", "keys": [["nope"]]},
		    {"path": "../outside.json", "format": "json", "keys": [["version"]]},
		    {"path": "missing.json", "format": "json", "keys": [["version"]]},
		    {"path": "package.json", "format": "yaml"}
		  ]},
		  "ci": {"jobs": [{"name": "a", "run": "true"}]}
		}`,
		"package.json": `{"version": "1.0.0-0"}`,
	})
	for _, want := range []string{
		`versions.firstpublic must be a public version, X.Y.Z (got "1.0")`,
		`versions.rcformat must be "numeric" (X.Y.Z-N) or "rcdot" (X.Y.Z-rc.N) (got "rc.N")`,
		`versions.files[0] (package.json): package.json: ["nope"] is missing`,
		`versions.files[1]: path "../outside.json" must be a file of the project`,
		"versions.files[2] (missing.json)",
		`versions.files[3] (package.json): package.json: format must be "json", "regex" or "text"`,
	} {
		if !hasMessage(report.Errors, want) {
			t.Errorf("missing error %q in %v", want, report.Errors)
		}
	}
}
