// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"encoding/json"
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
	report := validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x", "ci": {"jobs": [{"name": "a", "run": "true", "command": "x"}]}}`}).Strict()
	if report.Valid || !hasMessage(report.Errors, `ci.jobs[0]: unknown field "command"`) || hasMessage(report.Warnings, "command") {
		t.Fatalf("strict unknown field: %+v", report)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{broken`})
	if report.Valid || !report.Present || len(report.Errors) != 1 {
		t.Fatalf("broken JSON: %+v", report)
	}
}

// A field written for a newer MoltenTerm (#2370) is ignored with one warning naming it; the rest of the pipeline loads.
func TestPipelineUnknownFieldsWarn(t *testing.T) {
	base := map[string]any{
		"schema": 1, "name": "x",
		"ci":      map[string]any{"jobs": []any{map[string]any{"name": "a", "run": "true"}}},
		"builds":  []any{map[string]any{"id": "gold", "kind": "gold", "artifact": "out", "run": "true"}},
		"release": map[string]any{"rc": []any{map[string]any{"id": "cut", "phase": "cut", "confirm": "Push the tag?", "run": "true"}}},
	}
	for _, c := range []struct {
		name  string
		edit  func(p map[string]any)
		field string
		want  string
	}{
		{"top level", func(p map[string]any) { p["newthing"] = true }, "newthing", `unknown field "newthing" ignored: it needs a newer MoltenTerm`},
		{"release", func(p map[string]any) {
			p["release"].(map[string]any)["future"] = []any{map[string]any{"id": "x"}}
		}, "release.future", `release: unknown field "future" ignored`},
		{"job", func(p map[string]any) {
			p["ci"].(map[string]any)["jobs"].([]any)[0].(map[string]any)["timeout"] = 30
		}, "ci.jobs[0].timeout", `ci.jobs[0]: unknown field "timeout" ignored`},
		{"release step", func(p map[string]any) {
			p["release"].(map[string]any)["rc"].([]any)[0].(map[string]any)["retry"] = 2
		}, "release.rc[0].retry", `release.rc[0]: unknown field "retry" ignored`},
	} {
		t.Run(c.name, func(t *testing.T) {
			var p map[string]any
			raw, _ := json.Marshal(base)
			json.Unmarshal(raw, &p)
			c.edit(p)
			data, _ := json.Marshal(p)
			report := validateWith(t, map[string]string{".molten/project.json": string(data)})
			if !report.Valid || len(report.Errors) != 0 {
				t.Fatalf("an unknown field rejected the pipeline: %v", report.Errors)
			}
			if len(report.Unknown) != 1 || report.Unknown[0] != c.field {
				t.Fatalf("unknown: %v, want [%s]", report.Unknown, c.field)
			}
			count := 0
			for _, w := range report.Warnings {
				if strings.Contains(w, "unknown field") {
					count++
				}
			}
			if count != 1 || !hasMessage(report.Warnings, c.want) {
				t.Fatalf("warnings: %v, want one with %q", report.Warnings, c.want)
			}
			pl := report.Pipeline
			if len(pl.Ci.Jobs) != 1 || len(pl.Builds) != 1 || len(pl.Release.Rc) != 1 || pl.Release.Rc[0].Confirm == "" {
				t.Fatalf("the known parts were not loaded: %+v", pl)
			}
			strict := report.Strict()
			if strict.Valid || len(strict.Errors) != 1 || hasMessage(strict.Warnings, "unknown field") {
				t.Fatalf("strict: %+v", strict)
			}
		})
	}
}

// A known field with a wrong value still rejects the pipeline, and a key differing only by case is the known field,
// as encoding/json reads it.
func TestPipelineKnownFieldsStillChecked(t *testing.T) {
	report := validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x", "ci": {"jobs": [{"name": "a", "run": "true"}], "statuses": "gitlab"}}`})
	if report.Valid || !hasMessage(report.Errors, "ci.statuses must be") {
		t.Fatalf("invalid known value: %+v", report)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x", "ci": {"jobs": "a"}}`})
	if report.Valid || len(report.Errors) != 1 {
		t.Fatalf("wrong type: %+v", report)
	}
	report = validateWith(t, map[string]string{".molten/project.json": `{"Schema": 1, "name": "x", "ci": {"jobs": [{"name": "a", "run": "true", "env": {"ANY_NAME": "b"}}]}}`})
	if !report.Valid || len(report.Unknown) != 0 {
		t.Fatalf("case or env keys read as unknown: %+v", report)
	}
}

func TestValidatePipelineDataIsStrict(t *testing.T) {
	report := ValidatePipelineData(t.TempDir(), []byte(`{"schema": 1, "name": "x", "steps2": []}`))
	if report.Valid || !hasMessage(report.Errors, `unknown field "steps2"`) {
		t.Fatalf("the setup's draft must refuse unknown fields: %+v", report)
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

// #2365: release.preflight holds commands the release runs before it tags, so each is checked like any declared command.
func TestValidatePipelinePreflight(t *testing.T) {
	pipeline := func(checks string) PipelineReport {
		return validateWith(t, map[string]string{
			".molten/project.json": `{"schema": 1, "name": "x", "release": {"preflight": ` + checks + `}}`,
			"scripts/scan.mjs":     "",
		})
	}
	report := pipeline(`[
	  {"id": "scan", "title": "Scan", "run": "node scripts/scan.mjs --tag {tag}", "fix": "Read the report"},
	  {"id": "again", "run": "true", "cwd": "scripts"}
	]`)
	if !report.Valid {
		t.Fatalf("a declared preflight: %v", report.Errors)
	}
	checks := report.Pipeline.Release.Preflight
	if len(checks) != 2 || checks[0].Fix != "Read the report" || checks[1].Cwd != "scripts" {
		t.Fatalf("the checks were not read: %+v", checks)
	}
	for _, c := range []struct{ checks, want string }{
		{`[{"id": "Scan", "run": "true"}]`, `id "Scan" must be lowercase`},
		{`[{"id": "scan", "run": "true"}, {"id": "scan", "run": "true"}]`, `id "scan" is used twice`},
		{`[{"id": "scan"}]`, "run is empty"},
		{`[{"id": "scan", "run": "true", "cwd": "../elsewhere"}]`, "leaves the project"},
		{`[{"id": "scan", "run": "true {version} {nope}"}]`, "unknown variable {nope}"},
		{`[{"id": "scan", "run": "node scripts/missing.mjs"}]`, "scripts/missing.mjs does not exist"},
		{`[{"id": "scan", "run": "true", "env": {"A": "b"}}]`, `unknown field "env"`},
	} {
		got := pipeline(c.checks).Strict()
		if got.Valid || !hasMessage(got.Errors, c.want) {
			t.Errorf("%s: valid %v, errors %v, want one with %q", c.checks, got.Valid, got.Errors, c.want)
		}
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

// A build's verify is "ci" (a green GitHub run of the same commit is reused, else the local CI runs) or "ci-local" (the
// local CI always runs); both need ci.jobs, and anything else is refused (#2277).
func TestValidatePipelineBuildVerify(t *testing.T) {
	t.Parallel()
	pipeline := func(verify string, ci string) PipelineReport {
		return validateWith(t, map[string]string{".molten/project.json": `{"schema": 1, "name": "x",` + ci +
			`"builds": [{"id": "gold", "artifact": "out", "run": "true", "verify": ` + verify + `}]}`})
	}
	ci := `"ci": {"jobs": [{"name": "a", "run": "true"}]},`
	for _, verify := range []string{`"ci"`, `"ci-local"`} {
		report := pipeline(verify, ci)
		if !report.Valid || len(report.Errors) != 0 {
			t.Errorf("verify %s: %v", verify, report.Errors)
		}
		if !report.Pipeline.Builds[0].VerifiesWithCi() {
			t.Errorf("verify %s waits for a green CI", verify)
		}
		if report = pipeline(verify, ""); !hasMessage(report.Errors, "but the pipeline declares no ci.jobs") {
			t.Errorf("verify %s without ci.jobs: %v", verify, report.Errors)
		}
	}
	if report := pipeline(`"always"`, ci); !hasMessage(report.Errors, `verify must be "ci", "ci-local" or left out (got "always")`) {
		t.Errorf("an unknown verify: %v", report.Errors)
	}
	if (PipelineBuild{}).VerifiesWithCi() {
		t.Errorf("a build with no verify is not gated")
	}
}
