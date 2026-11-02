// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The release's files go through the project's formatter before the release commit (#1095). No real formatter runs
// here: the fixture's "prettier" is a shell script the fixture's install step copies into node_modules/.bin. It strips
// trailing spaces and squeezes blank lines in markdown files, and with --check fails on a file it would change, as
// SaaSFoundryAI's `npm run format:check` does.

const fakePrettier = `#!/bin/sh
check=0
files=0
for arg in "$@"; do
	case "$arg" in
	--check) check=1 ;;
	--write|--ignore-unknown|--) ;;
	*.md)
		files=$((files+1))
		awk 'NF { blank = 0; sub(/[ \t]+$/, ""); print; next } !blank++ { print }' "$arg" > "$arg.fmt"
		if [ "$check" = 1 ]; then
			cmp -s "$arg" "$arg.fmt" || { rm -f "$arg.fmt"; echo "[warn] $arg" >&2; exit 1; }
			rm -f "$arg.fmt"
		else
			mv "$arg.fmt" "$arg"
		fi ;;
	esac
done
echo "fake prettier: $files file(s)" >> "$FAKE_PRETTIER_LOG"
`

// The fixture's pipeline with a changelog the cut commits, and an install step that puts the fake prettier in place.
const formatProject = `{
    "schema": 1,
    "name": "Fixture",
    "branches": { "trunk": "develop", "release": "main" },
    "ci": { "prepare": { "run": "mkdir -p node_modules/.bin && cp ../fake-prettier node_modules/.bin/prettier" }, "jobs": [{ "name": "t", "run": "true" }] },
    "versions": {
        "tagprefix": "v",
        "notes": "releases/{tag}.md",
        "firstpublic": "1.0.0",
        "changelogs": ["CHANGELOG.md"],
        FORMAT
        "files": [
            { "path": "package.json", "format": "json", "keys": [["version"]] },
            { "path": "package-lock.json", "format": "json", "keys": [["version"], ["packages", "", "version"]] }
        ]
    }
}
`

// formatFixture sets the fixture up for the pull-request flow with a formatter: extra files written and committed on
// develop (and main), the fake prettier beside the checkout.
func formatFixture(t *testing.T, format string, extra map[string]string) (*fixture, *Env, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake formatter is a shell script")
	}
	f := makeFixture(t)
	log := filepath.Join(f.base, "prettier.log")
	t.Setenv("FAKE_PRETTIER_LOG", log)
	writeFile(t, filepath.Join(f.base, "fake-prettier"), fakePrettier)
	if err := os.Chmod(filepath.Join(f.base, "fake-prettier"), 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), strings.Replace(formatProject, "FORMAT", format, 1))
	writeFile(t, filepath.Join(f.checkout, ".gitignore"), "node_modules/\n")
	writeFile(t, filepath.Join(f.checkout, "CHANGELOG.md"), "# Changelog\n")
	for path, text := range extra {
		writeFile(t, filepath.Join(f.checkout, path), text)
	}
	gitIn(t, f.checkout, "add", "-A")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#2): the formatter")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop", "develop:main")
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"pass"}, state: "CLEAN"}
	e := f.env()
	e.Run = gh.run
	return f, e, log
}

// A changelog section written by hand between prepare and open-pr, unformatted.
func writeChangelogSection(t *testing.T, f *fixture) {
	t.Helper()
	writeFile(t, filepath.Join(f.worktree(), "CHANGELOG.md"), "# Changelog\n\n\n\n## [1.0.0-1]   \n\n- A change.  \n")
}

// prettierCheck runs the fake prettier --check on a file of origin's branch, as the project's CI would.
func prettierCheck(t *testing.T, f *fixture, branch string, path string) error {
	t.Helper()
	file := filepath.Join(t.TempDir(), filepath.Base(path))
	writeFile(t, file, f.originFile(t, branch, path)+"\n")
	return exec.Command(filepath.Join(f.base, "fake-prettier"), "--check", file).Run()
}

func TestOpenPrCommitsTheFilesAsThePrettierOfTheProjectWritesThem(t *testing.T) {
	f, e, log := formatFixture(t, "", map[string]string{".prettierrc": "{}\n", "package.json": "{\n    \"name\": \"fixture\",\n    \"version\": \"1.0.0-0\"\n}\n"})
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), FormatMarker+FormatFormatted+" "+FormatterPrettier) {
		t.Fatalf("prepare formats the notes it wrote:\n%s", f.out.String())
	}
	writeChangelogSection(t, f)
	// The notes edited by hand in the release panel, unformatted too.
	notes := filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")
	writeFile(t, notes, readFile(t, notes)+"\n\n\nEdited by hand.   \n")
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0-1"))
	if runs := strings.Count(readFile(t, log), "fake prettier"); runs != 2 {
		t.Fatalf("prettier runs once after prepare and once before the commit, ran %d time(s)", runs)
	}
	for _, path := range []string{"CHANGELOG.md", "releases/v1.0.0-1.md", "releases/v1.0.0-1.internal.md"} {
		if err := prettierCheck(t, f, "rc-1.0.0", path); err != nil {
			t.Fatalf("the open-pr commit's %s does not pass the project's format check: %v\n%s", path, err, f.originFile(t, "rc-1.0.0", path))
		}
	}
	if got := f.originFile(t, "rc-1.0.0", "CHANGELOG.md"); !strings.Contains(got, "## [1.0.0-1]\n\n- A change.") {
		t.Fatalf("CHANGELOG.md: %q", got)
	}
	if status := gitIn(t, f.worktree(), "status", "--porcelain"); status != "" {
		t.Fatalf("the release commit holds everything the formatter changed: %q", status)
	}
}

func TestTheDeclaredFormatterComesFirst(t *testing.T) {
	declared := `"format": "../fake-prettier --write",`
	f, e, log := formatFixture(t, declared, map[string]string{".prettierrc": "{}\n"})
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), FormatMarker+FormatFormatted+" "+FormatterDeclared) {
		t.Fatalf("the declared formatter formats the notes:\n%s", f.out.String())
	}
	if _, err := os.Stat(filepath.Join(f.worktree(), "node_modules")); err == nil {
		t.Fatal("the declared formatter needs no dependencies installed")
	}
	if !strings.Contains(readFile(t, log), "fake prettier") {
		t.Fatal("the declared command ran")
	}
}

func TestAMissingOrFailingFormatterIsSaidAndBlocksNothing(t *testing.T) {
	f, e, _ := formatFixture(t, "", nil)
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), FormatMarker+FormatNone) || !strings.Contains(f.out.String(), "declare its formatter in versions.format") {
		t.Fatalf("no formatter is said:\n%s", f.out.String())
	}
	writeChangelogSection(t, f)
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0-1"))
	if got := f.originFile(t, "rc-1.0.0", "CHANGELOG.md"); !strings.Contains(got, "## [1.0.0-1]   ") {
		t.Fatalf("without a formatter the changelog is committed as written: %q", got)
	}

	failing, e2, _ := formatFixture(t, `"format": "false",`, nil)
	mustRun(t, failing, "prepare --pr with a failing formatter", e2.PreparePr(ctx, "v1.0.0-1"))
	out := failing.out.String()
	if !strings.Contains(out, FormatMarker+FormatFailed+" false 'package-lock.json' 'package.json' 'releases/v1.0.0-1.internal.md' 'releases/v1.0.0-1.md'") || !strings.Contains(out, "not formatted the way the project's CI checks") {
		t.Fatalf("a failing formatter is said with the command to run:\n%s", out)
	}
}

func TestFormatterDetection(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"none", map[string]string{"package.json": `{"name":"x"}`}, ""},
		{"config file", map[string]string{"prettier.config.mjs": "export default {}"}, FormatterPrettier},
		{"package.json key", map[string]string{"package.json": `{"prettier":{"semi":false}}`}, FormatterPrettier},
		{"dev dependency", map[string]string{"package.json": `{"devDependencies":{"prettier":"3.3.3"}}`}, FormatterPrettier},
		{"a dependency named alike", map[string]string{"package.json": `{"devDependencies":{"prettier-plugin-x":"1.0.0"}}`}, ""},
	}
	for _, c := range cases {
		wt := t.TempDir()
		for path, text := range c.files {
			writeFile(t, filepath.Join(wt, path), text)
		}
		got := ""
		if f := formatterOf(wt, &Project{}); f != nil {
			got = f.Name
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	if f := formatterOf(t.TempDir(), &Project{Format: "npm run fmt --"}); f == nil || f.Name != FormatterDeclared || f.NeedsDependencies {
		t.Fatalf("declared: %+v", f)
	}
}
