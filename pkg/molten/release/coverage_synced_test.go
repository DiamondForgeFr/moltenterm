// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// SaaSFoundryAI's 1.1.0 (#1717): the 1.0.1 release reached main under other hashes (its pull request rebased onto
// main, one commit changed on the way), then main was merged back into develop. develop keeps the original commits,
// v1.0.1 their copies, and v1.0.1..HEAD lists both the release's work and the new one.
func makeSyncedBackRepo(t *testing.T) string {
	t.Helper()
	dir, change := makeSyncedBackBase(t)
	change("thirty.txt", "fix(#30): the board loses its title")
	change("thirtyone.txt", "feat(#31): share a board")
	change("thirtytwo.txt", "docs(#32): the sharing guide")
	return dir
}

// makeSyncedBackBase is makeSyncedBackRepo up to the sync-back, with nothing new on develop yet; change commits a file.
func makeSyncedBackBase(t *testing.T) (string, func(file string, subject string, body ...string) string) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Release test")
	t.Setenv("GIT_AUTHOR_EMAIL", "release@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Release test")
	t.Setenv("GIT_COMMITTER_EMAIL", "release@example.invalid")
	dir := t.TempDir()
	gitIn(t, dir, "init", "--quiet", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", "https://example.invalid/acme/app.git")
	writeFile(t, filepath.Join(dir, ".molten", "project.json"), coverageProject)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#1): bootstrap")
	change := func(file string, subject string, body ...string) string {
		writeFile(t, filepath.Join(dir, file), subject+"\n")
		gitIn(t, dir, "add", "-A")
		args := []string{"commit", "--quiet", "-m", subject}
		for _, paragraph := range body {
			args = append(args, "-m", paragraph)
		}
		gitIn(t, dir, args...)
		return gitIn(t, dir, "rev-parse", "HEAD")
	}
	change("first.txt", "feat(#5): the first public feature")
	gitIn(t, dir, "tag", "v1.0.0")
	gitIn(t, dir, "branch", "main")
	shipped := []string{
		change("ten.txt", "fix(#10): the crash on start"),
		change("eleven.txt", "feat(#11): export the board", "BREAKING CHANGE: the export format changed."),
	}
	twelve := change("twelve.txt", "feat(#12): import a board")

	gitIn(t, dir, "checkout", "--quiet", "main")
	for _, c := range shipped {
		// -x: within the same second, a plain cherry-pick onto the same parent would be the very same commit.
		gitIn(t, dir, "cherry-pick", "-x", c)
	}
	// A conflict resolved on the way: the patch is not the original's any more, its author date and subject are.
	gitIn(t, dir, "cherry-pick", "-x", twelve)
	writeFile(t, filepath.Join(dir, "twelve-fixup.txt"), "resolved\n")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "--amend", "--no-edit")
	change("CHANGELOG.txt", "chore(release): v1.0.1")
	gitIn(t, dir, "tag", "v1.0.1")

	gitIn(t, dir, "checkout", "--quiet", "develop")
	gitIn(t, dir, "merge", "--quiet", "--no-ff", "-m", "Merge branch 'main' into develop", "main")
	return dir, change
}

// #1731: v1.0.1's commits came back to develop under other hashes, one with a breaking change; since then only a fix
// and docs landed. The plan proposes the patch the new commits justify, not the major or minor of the shipped ones.
func TestPlanLeavesOutTheReleaseSyncedBack(t *testing.T) {
	dir, change := makeSyncedBackBase(t)
	change("thirty.txt", "fix(#30): the board loses its title", "The title is kept on save.")
	change("thirtytwo.txt", "docs(#32): the sharing guide")
	// A local origin: the plan reads origin/develop, not HEAD.
	origin := t.TempDir()
	gitIn(t, origin, "init", "--quiet", "--bare")
	gitIn(t, dir, "remote", "set-url", "origin", origin)
	gitIn(t, dir, "push", "--quiet", "--tags", "origin", "develop", "main")
	gitIn(t, dir, "checkout", "--quiet", "main")
	if out := gitIn(t, dir, "log", "--no-merges", "--format=%s", "v1.0.1..origin/develop"); !strings.Contains(out, "#11") {
		t.Fatalf("the fixture must hold v1.0.1's work again under other hashes: %q", out)
	}

	reports, err := coverageEnv(dir).Plan(context.Background(), []string{"public", "rc"}, "")
	if err != nil {
		t.Fatal(err)
	}
	public, rc := reports[0], reports[1]
	if public.LastPublic != "v1.0.1" || public.Base != "1.0.2" || public.Level != "patch" || public.Tag != "v1.0.2" {
		t.Fatalf("public plan: %+v: only the fix since v1.0.1 counts, not the shipped breaking feat", public)
	}
	for _, shipped := range []string{"#10", "#11", "#12"} {
		if strings.Contains(public.Reason, shipped) {
			t.Fatalf("the reason cites v1.0.1's %s: %q", shipped, public.Reason)
		}
	}
	if rc.Base != "1.0.2" || rc.Tag != "v1.0.2-1" {
		t.Fatalf("rc plan: %+v", rc)
	}

	// The commit bodies still reach the bump: a breaking change after the release makes it major.
	gitIn(t, dir, "checkout", "--quiet", "develop")
	change("forty.txt", "fix(#40): the import keeps the order", "BREAKING CHANGE: boards import in their saved order.")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
	reports, err = coverageEnv(dir).Plan(context.Background(), []string{"public"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if reports[0].Base != "2.0.0" || reports[0].Level != "major" {
		t.Fatalf("a breaking change since v1.0.1 makes a major version: %+v", reports[0])
	}
}

func TestChangelogItemsLeaveOutTheReleaseSyncedBack(t *testing.T) {
	dir := makeSyncedBackRepo(t)
	if out := gitIn(t, dir, "log", "--no-merges", "--format=%s", "v1.0.1..HEAD"); !strings.Contains(out, "#10") {
		t.Fatalf("the fixture must hold v1.0.1's work again under other hashes: %q", out)
	}
	env := coverageEnv(dir)
	since, items, err := env.ChangelogItems(context.Background(), "v1.1.0")
	if err != nil || since != "v1.0.1" {
		t.Fatalf("since %q: %v", since, err)
	}
	var tickets []int
	for _, item := range items {
		tickets = append(tickets, item.Ticket)
	}
	if !slices.Equal(tickets, []int{31, 30}) {
		t.Fatalf("tickets %v: only the work since v1.0.1, not the release's commits synced back to develop", tickets)
	}
	if items[0].Type != "feat" || items[0].Subject != "feat(#31): share a board" || items[1].Type != "fix" {
		t.Fatalf("each item says the commit it comes from: %+v", items)
	}

	// The public notes draft reads the same range.
	p, v, err := env.tagVersion(context.Background(), "v1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	facts, err := env.gatherNotesFacts(context.Background(), dir, p, "v1.1.0", v)
	if err != nil {
		t.Fatal(err)
	}
	draft := DraftNotes(facts)
	if !strings.Contains(draft, "Share a board") || !strings.Contains(draft, "The board loses its title") {
		t.Fatalf("draft: %s", draft)
	}
	for _, shipped := range []string{"crash on start", "xport the board", "mport a board"} {
		if strings.Contains(draft, shipped) {
			t.Fatalf("the draft repeats v1.0.1's %q: %s", shipped, draft)
		}
	}
}

const changelogWithEarlierSection = `# Changelog

## [1.1.0] - 2026-11-01

- Share a board (#31).

## [1.0.1] - 2026-10-09

- Import a board ([#12](https://github.com/acme/app/issues/12)).
- Export the board (#11).

## [1.0.0]

- The first public feature (#5).
`

func TestUncoveredLeavesOutTicketsAnEarlierSectionCites(t *testing.T) {
	items := CoverageItems([]string{"fix(#30): the board loses its title", "feat(#31): share a board", "feat(#12): import a board", "feat(#11): export the board", "fix: typo in the help"}, "")
	section, _ := ChangelogSection(changelogWithEarlierSection, "1.1.0", "")
	earlier := ChangelogEarlier(changelogWithEarlierSection, "1.1.0", "")
	if strings.Contains(earlier, "#31") || !strings.Contains(earlier, "## [1.0.1]") {
		t.Fatalf("earlier: %q", earlier)
	}
	var missing []string
	for _, item := range NotCitedEarlier(UncoveredItems(section, items, "en"), earlier) {
		missing = append(missing, item.String())
	}
	if !slices.Equal(missing, []string{"#30", "typo in the help"}) {
		t.Fatalf("missing %v: #11 and #12 shipped in 1.0.1, #31 is in the section, #30 is the omission", missing)
	}
	if left := NotCitedEarlier(items, ChangelogEarlier(changelogWithEarlierSection, "2.0.0", "")); len(left) != len(items) {
		t.Fatalf("no section, nothing earlier: %+v", left)
	}
	byCheck := ChangelogEarlier(changelogWithEarlierSection, "1.1.0", "## [1.1.0]")
	if byCheck != earlier {
		t.Fatalf("the check's heading finds the same sections: %q", byCheck)
	}
}
