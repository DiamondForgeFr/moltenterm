// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// A project numbering its candidates X.Y.Z-rc.N (#1155): v1.0.1 public, then v1.1.0-1 from before the switch and
// v1.1.0-rc.2 after it, on the way to the public v1.1.0.
func makeRcDotRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Release test")
	t.Setenv("GIT_AUTHOR_EMAIL", "release@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Release test")
	t.Setenv("GIT_COMMITTER_EMAIL", "release@example.invalid")
	dir := t.TempDir()
	gitIn(t, dir, "init", "--quiet", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", "https://github.com/o/r.git")
	writeFile(t, filepath.Join(dir, ".molten", "project.json"), `{"schema":1,"name":"rcdot","versions":{"rcformat":"rcdot","changelogs":["CHANGELOG.md"]}}`)
	gitIn(t, dir, "add", "-A")
	commit := func(subject string, tags ...string) {
		gitIn(t, dir, "commit", "--quiet", "--allow-empty", "-m", subject)
		for _, tag := range tags {
			gitIn(t, dir, "tag", tag)
		}
	}
	commit("fix(#8): a patch", "v1.0.1")
	commit("feat(#20): export the board", "v1.1.0-1")
	commit("feat(#22): import a board")
	commit("fix(#21): the crash on start", "v1.1.0-rc.2")
	commit("fix(#24): a late fix", "v1.1.0-rc.3")
	commit("feat(#25): after the last candidate")
	return dir
}

func TestRcDotReleasesReadTheirProject(t *testing.T) {
	dir := makeRcDotRepo(t)
	p, err := coverageEnv(dir).LoadProject(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if p.Rules.RcFormat != versions.RcFormatRcDot {
		t.Fatalf("rules: %+v", p.Rules)
	}
	tags := []string{"v1.0.1", "v1.1.0-1", "v1.1.0-rc.2", "v1.1.0-rc.3"}
	for tag, channel := range map[string]string{"v1.1.0-rc.3": versions.ChannelRc, "v1.1.0-1": versions.ChannelRc, "v1.1.0": versions.ChannelPublic} {
		v, got, err := p.releaseOf(tag)
		if err != nil || got != channel || p.Rules.Tag(v) != tag {
			t.Fatalf("%s: %s %v (%v)", tag, got, v, err)
		}
	}
	next, _ := versions.ParseVersion("1.1.0-rc.4")
	if err := p.checkNumber(next, tags); err != nil {
		t.Fatalf("the next candidate: %v", err)
	}
	for _, tag := range []string{"1.1.0-rc.3", "1.1.0-rc.5", "1.1.0-4"} {
		v, _ := versions.ParseVersion(tag)
		if err := p.checkNumber(v, tags); err == nil {
			t.Fatalf("%s is not the next candidate", tag)
		}
	}
	if _, _, err := p.releaseOf("v1.1.0-rc.0"); err == nil {
		t.Fatal("rc.0 is not a release")
	}
}

func TestRcDotNotesRangeAndChangelogScope(t *testing.T) {
	dir := makeRcDotRepo(t)
	env := coverageEnv(dir)
	for tag, want := range map[string]string{"v1.1.0": "v1.0.1", "v1.1.0-rc.3": "v1.1.0-rc.2", "v1.1.0-rc.2": "v1.1.0-1", "v1.1.0-1": "v1.0.1"} {
		since, err := env.ChangelogSince(context.Background(), tag)
		if err != nil || since != want {
			t.Fatalf("%s: since %q (%v), want %q", tag, since, err, want)
		}
	}
	since, items, err := env.ChangelogItems(context.Background(), "v1.1.0")
	if err != nil || since != "v1.0.1" {
		t.Fatalf("since %q: %v", since, err)
	}
	var tickets []int
	for _, item := range items {
		tickets = append(tickets, item.Ticket)
	}
	if !slices.Equal(tickets, []int{25, 24, 21, 22, 20}) {
		t.Fatalf("tickets %v: every candidate's work since v1.0.1, in both forms", tickets)
	}
}

// The chain cuts an X.Y.Z-rc.N candidate as it cuts X.Y.Z-N: the tag, the version files, the notes, the release
// commit, the sync-back branch.
func TestRcDotCandidateIsCutEndToEnd(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	project := strings.Replace(fixtureProject, `"firstpublic": "1.0.0",`, `"firstpublic": "1.0.0", "rcformat": "rcdot",`, 1)
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), project)
	gitIn(t, f.checkout, "commit", "--quiet", "-am", "chore(#1): number candidates rc.N")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	f.commitOnDevelop(t, "feat(#2): a second feature")

	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustFail(t, f, "a -N candidate is still read, but a skipped number is refused", e.Prepare(ctx, "v1.0.0-2"), "next release candidate of 1.0.0 is v1.0.0-rc.1")
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-rc.1"))
	if !strings.Contains(readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-rc.1.md")), "A second feature") {
		t.Fatal("no notes for the rc.N candidate")
	}
	if got := readFile(t, filepath.Join(f.worktree(), "package-lock.json")); strings.Count(got, `"1.0.0-rc.1"`) != 2 {
		t.Fatalf("package-lock.json not bumped to 1.0.0-rc.1:\n%s", got)
	}
	mustRun(t, f, "finalize", e.Finalize(ctx, "v1.0.0-rc.1"))
	if f.originRef(t, "v1.0.0-rc.1") != f.originRef(t, "main") {
		t.Fatal("the tag is not main's tip on origin")
	}
	if msg := gitIn(t, f.origin, "log", "-1", "--format=%s", "main"); msg != "chore(release): v1.0.0-rc.1 (rc)" {
		t.Fatalf("release commit %q", msg)
	}
	if !strings.Contains(f.originFile(t, "v1.0.0-rc.1", "package.json"), `"version": "1.0.0-rc.1"`) {
		t.Fatal("package.json not bumped in the release commit")
	}
	mustRun(t, f, "sync-back", e.SyncBack(ctx, "v1.0.0-rc.1"))
	if creates := f.gh.called("pr", "create"); len(creates) != 1 || !strings.Contains(strings.Join(creates[0], " "), "--head chore/sync-back-v1.0.0-rc.1") {
		t.Fatalf("sync-back pull request: %v", creates)
	}
}

func TestChangelogSectionOfAnRcDotProject(t *testing.T) {
	changelog := "# Changelog\n\n## [1.1.0-rc.2]\n\n- Import (#22).\n\n## [1.1.0-1]\n\n- Export (#20).\n"
	if _, ok := ChangelogSection(changelog, "1.1.0", ""); ok {
		t.Fatal("a candidate's heading, rc.N or N, is not the public version's")
	}
	section, ok := ChangelogSection(changelog, "1.1.0-rc.2", "")
	if !ok || section != "## [1.1.0-rc.2]\n\n- Import (#22).\n" {
		t.Fatalf("section: %q", section)
	}
	if _, ok := ChangelogSection(changelog, "1.1.0-rc.1", ""); ok {
		t.Fatal("rc.1 is not rc.2... nor rc.12")
	}
	if _, ok := ChangelogSection("## 1.1.0 - 2026-10-27\n", "1.1.0", ""); !ok {
		t.Fatal("a dated heading names its version")
	}
	if _, ok := ChangelogSection("## 1.1.0-rcx\n", "1.1.0", ""); !ok {
		t.Fatal("only rc.N is a candidate's form")
	}
}
