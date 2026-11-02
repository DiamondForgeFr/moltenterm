// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const coverageProject = `{"schema":1,"name":"SaaSFoundryAI","versions":{"tagprefix":"v","firstpublic":"1.0.0","changelogs":["docs/changelog.md","docs/fr/changelog.md"]}}`

// SaaSFoundryAI-shaped history (#1142): v1.0.0-beta from before the numbering, v1.0.0 and v1.0.1 public, then the
// candidates v1.1.0-1 and v1.1.0-2 on the way to the public v1.1.0.
func makeCoverageRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Release test")
	t.Setenv("GIT_AUTHOR_EMAIL", "release@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Release test")
	t.Setenv("GIT_COMMITTER_EMAIL", "release@example.invalid")
	dir := t.TempDir()
	gitIn(t, dir, "init", "--quiet", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", "https://github.com/DiamondForgeFr/SaasFoundryAI.git")
	writeFile(t, filepath.Join(dir, ".molten", "project.json"), coverageProject)
	gitIn(t, dir, "add", "-A")
	commit := func(subject string, tags ...string) {
		gitIn(t, dir, "commit", "--quiet", "--allow-empty", "-m", subject)
		for _, tag := range tags {
			gitIn(t, dir, "tag", tag)
		}
	}
	commit("chore(#1): bootstrap", "v1.0.0-beta")
	commit("feat(#5): the first public feature", "v1.0.0")
	commit("fix(#8): a patch", "v1.0.1")
	commit("feat(#20): export the board")
	commit("fix(#21): the crash on start", "v1.1.0-1")
	commit("feat(#22): import a board")
	commit("chore(#23): CI cache")
	commit("fix: typo in the help", "v1.1.0-2")
	commit("fix(#24): a late fix")
	return dir
}

func coverageEnv(dir string) *Env {
	return &Env{Dir: dir, Run: ExecRunner}
}

func TestChangelogSinceSkipsCandidatesForAPublicVersion(t *testing.T) {
	dir := makeCoverageRepo(t)
	env := coverageEnv(dir)
	for tag, want := range map[string]string{"v1.1.0": "v1.0.1", "v1.1.0-2": "v1.1.0-1", "v1.1.0-1": "v1.0.1"} {
		since, err := env.ChangelogSince(context.Background(), tag)
		if err != nil || since != want {
			t.Fatalf("%s: since %q (%v), want %q", tag, since, err, want)
		}
	}
}

func TestChangelogItemsCoverTheCandidatesRange(t *testing.T) {
	dir := makeCoverageRepo(t)
	since, items, err := coverageEnv(dir).ChangelogItems(context.Background(), "v1.1.0")
	if err != nil || since != "v1.0.1" {
		t.Fatalf("since %q: %v", since, err)
	}
	var tickets []int
	var untracked []string
	for _, item := range items {
		if item.Ticket == 0 {
			untracked = append(untracked, item.Text)
			continue
		}
		tickets = append(tickets, item.Ticket)
		if item.Url != "https://github.com/DiamondForgeFr/SaasFoundryAI/issues/"+strconv.Itoa(item.Ticket) {
			t.Fatalf("link: %+v", item)
		}
	}
	if !slices.Equal(tickets, []int{24, 22, 21, 20}) || !slices.Equal(untracked, []string{"typo in the help"}) {
		t.Fatalf("tickets %v, untracked %v: the candidates' user-facing work since v1.0.1, chores and v1.0.1's own fix left out", tickets, untracked)
	}
}

const englishChangelog = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-10-27

### Added

- Export a board ([#20](https://github.com/DiamondForgeFr/SaasFoundryAI/issues/20)).

### Fixed

- A late fix (#24).

## [1.0.1] - 2026-10-09

- A patch (#21 is named here, in another section).
`

func TestChangelogSectionStopsAtTheNextVersion(t *testing.T) {
	section, ok := ChangelogSection(englishChangelog, "1.1.0", "")
	if !ok || !strings.Contains(section, "#24") || strings.Contains(section, "1.0.1") {
		t.Fatalf("section: %q", section)
	}
	byCheck, ok := ChangelogSection(englishChangelog, "1.1.0", "## [1.1.0]")
	if !ok || byCheck != section {
		t.Fatalf("the check's heading finds the same section: %q", byCheck)
	}
	if _, ok := ChangelogSection(englishChangelog, "1.1.0-2", ""); ok {
		t.Fatal("no section of a candidate")
	}
	if _, ok := ChangelogSection("## [1.1.0-2]\n", "1.1.0", ""); ok {
		t.Fatal("a candidate's heading is not the public version's")
	}
}

func TestUncoveredItemsOfASectionMissingTheCandidatesRange(t *testing.T) {
	items := CoverageItems([]string{"fix(#24): a late fix", "fix: typo in the help", "feat(#22): import a board", "fix(#21): the crash on start", "feat(#20): export the board", "chore(#23): CI cache"}, "")
	section, _ := ChangelogSection(englishChangelog, "1.1.0", "")
	var missing []string
	for _, item := range UncoveredItems(section, items, "en") {
		missing = append(missing, item.String())
	}
	if !slices.Equal(missing, []string{"typo in the help", "#22", "#21"}) {
		t.Fatalf("missing %v: #21 is named only in v1.0.1's section", missing)
	}

	complete := section + "- Import a board (#22).\n- The crash on start ([#21](https://github.com/o/r/pull/21)).\n- Typo in the help.\n"
	if left := UncoveredItems(complete, items, "en"); len(left) != 0 {
		t.Fatalf("a complete section leaves nothing: %+v", left)
	}

	french := "## [1.1.0]\n\n- Export d'un tableau (#20), import (#22), correctif tardif (#24), plantage au démarrage (#21).\n"
	if left := UncoveredItems(french, items, "fr"); len(left) != 0 {
		t.Fatalf("a French section is compared by its tickets, not the English subjects: %+v", left)
	}
	if left := UncoveredItems("## [1.1.0]\n\n- #220 et #2\n", items[:1], "fr"); len(left) != 1 {
		t.Fatalf("#220 and #2 are not #24: %+v", left)
	}
}

func TestNotesPromptSaysTheScope(t *testing.T) {
	public := notesPrompt(NotesFacts{Tag: "v1.1.0", Channel: "public", Since: "v1.0.1"}, "")
	if !strings.Contains(public, "since v1.0.1, the last public release, release candidates included") {
		t.Fatalf("public prompt: %s", public)
	}
	rc := notesPrompt(NotesFacts{Tag: "v1.1.0-2", Channel: "rc", Since: "v1.1.0-1"}, "")
	if !strings.Contains(rc, "since v1.1.0-1, the previous release of either channel") {
		t.Fatalf("rc prompt: %s", rc)
	}
}
