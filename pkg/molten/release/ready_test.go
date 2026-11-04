// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The readiness of a release (#1800): everything known to stop it is checked before the first step that writes, and
// reported in one list. It fixes the bookkeeping itself and blocks on nothing GitHub or the system would not refuse.

func notCreated(t *testing.T, f *fixture) {
	t.Helper()
	if _, err := os.Stat(f.worktree()); err == nil {
		t.Fatalf("the release worktree was created:\n%s", f.out.String())
	}
}

func TestReadyCreatesTheMissingTicketAndWritesNothingElse(t *testing.T) {
	f, e, _ := ticketFixture(t)
	f.gh.issues = `[]`
	mainBefore, developBefore := f.originRef(t, "main"), f.originRef(t, "develop")
	mustRun(t, f, "ready", e.Ready(context.Background(), "v1.0.0-1", false))
	for _, want := range []string{
		"Checking that v1.0.0-1 is ready to be cut.",
		"fixed    Created #1801, the release ticket of milestone v1.0.0 (Release v1.0.0).",
		"ok       v1.0.0-1 is not taken",
		"ok       milestone v1.0.0 is open",
		"v1.0.0-1 is ready.",
	} {
		if !strings.Contains(f.out.String(), want) {
			t.Fatalf("the report lacks %q:\n%s", want, f.out.String())
		}
	}
	notCreated(t, f)
	if f.originRef(t, "main") != mainBefore || f.originRef(t, "develop") != developBefore {
		t.Fatal("a branch of origin moved")
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 1 {
		t.Fatalf("tickets created: %v", calls)
	}
}

func TestReadyReportsEveryProblemInOneListBeforeAnythingIsWritten(t *testing.T) {
	f, e, _ := ticketFixture(t)
	f.github = false
	err := e.Ready(context.Background(), "v1.0.0-2", false)
	mustFail(t, f, "ready", err, "v1.0.0-2 is not ready, nothing was changed")
	for _, want := range []string{"next release candidate of 1.0.0 is v1.0.0-1", "pass --ticket N, or put an issue titled \"Release v1.0.0\""} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error lacks %q: %v", want, err)
		}
		if !strings.Contains(f.out.String(), "problem  ") || !strings.Contains(f.out.String(), want) {
			t.Fatalf("the report lacks %q:\n%s", want, f.out.String())
		}
	}
	if !strings.Contains(f.out.String(), "ok       origin has main") {
		t.Fatalf("what is fine is said too:\n%s", f.out.String())
	}
	notCreated(t, f)
}

func TestPrepareStopsBeforeItWritesWhenTheReleaseIsNotReady(t *testing.T) {
	f, e, _ := ticketFixture(t)
	f.gh.issues = `[]`
	f.gh.createFails = fmt.Errorf("gh: Resource not accessible by integration")
	err := e.Prepare(context.Background(), "v1.0.0-1")
	mustFail(t, f, "prepare", err, "could not create the release ticket \"Release v1.0.0\"")
	mustFail(t, f, "prepare", err, "v1.0.0-1 is not ready, nothing was changed")
	notCreated(t, f)
	if gitIn(t, f.checkout, "tag", "--list", "v1.0.0-1") != "" {
		t.Fatal("a tag was made")
	}
}

// The stop of v1.0.0-7: the commit format named a ticket and the milestone held none, found at "Commit, tag and push".
func TestTheCutCreatesTheMissingReleaseTicketBeforeItWrites(t *testing.T) {
	f, e, _ := ticketFixture(t)
	f.gh.issues = `[]`
	ctx := context.Background()
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "Created #1801, the release ticket of milestone v1.0.0") {
		t.Fatalf("the preparation did not make the ticket:\n%s", f.out.String())
	}
	// finalize is another process: it finds what the preparation made.
	f.gh.issues = `[{"number":1801,"title":"Release v1.0.0"}]`
	mustRun(t, f, "finalize", f.env().Finalize(ctx, "v1.0.0-1"))
	if subject := gitIn(t, f.origin, "log", "-1", "--format=%s", "v1.0.0-1"); subject != "chore(#1801): release v1.0.0-1" {
		t.Fatalf("release commit subject %q", subject)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 1 {
		t.Fatalf("tickets created: %v", calls)
	}
}

func TestFinalizeNamesEveryProblemAtOnce(t *testing.T) {
	f, e, _ := ticketFixture(t)
	f.gh.issues = `[{"number":1801,"title":"Release v1.0.0"}]`
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	writeFile(t, filepath.Join(f.worktree(), "stray.txt"), "left over\n")
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	writeFile(t, filepath.Join(f.checkout, "hotfix.txt"), "x\n")
	gitIn(t, f.checkout, "add", "hotfix.txt")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "fix(#5): hotfix")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "hotfix:main")
	f.gh.issues = `[]`
	f.gh.createFails = fmt.Errorf("gh: HTTP 403")
	err := f.env().Finalize(ctx, "v1.0.0-1")
	mustFail(t, f, "finalize", err, "v1.0.0-1 is not ready, nothing was committed")
	for _, want := range []string{"moved since the preparation", "stray.txt", "could not create the release ticket"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error lacks %q: %v", want, err)
		}
	}
	if f.tagOnOrigin(t, "v1.0.0-1") {
		t.Fatal("a refused finalize pushed the tag")
	}
}

// A warning reports, a milestone never blocks (FR-REL-002).
func TestReadyBlocksOnlyOnWhatGithubOrTheSystemRefuse(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	mustRun(t, f, "a milestone with open issues", f.env().Ready(ctx, "v1.0.0-1", false))
	if !strings.Contains(f.out.String(), "warning  1 open issue(s) in milestone 1.0.0 (reported, not blocking)") {
		t.Fatalf("the open issues are said:\n%s", f.out.String())
	}

	f = makeFixture(t)
	f.gh.milestones = `[{"number":3,"title":"Later","html_url":"https://m/3","open_issues":0}]`
	mustRun(t, f, "no milestone for the version", f.env().Ready(ctx, "v1.0.0-1", false))
	if !strings.Contains(f.out.String(), "warning  no open milestone for 1.0.0") {
		t.Fatalf("the missing milestone is said:\n%s", f.out.String())
	}

	f = makeFixture(t)
	f.github = false
	mustRun(t, f, "off GitHub", f.env().Ready(ctx, "v1.0.0-1", false))
	if len(f.gh.calls) != 0 {
		t.Fatalf("gh was called off GitHub: %v", f.gh.calls)
	}

	f = makeFixture(t)
	f.gh.milestonesFail = fmt.Errorf("gh auth status: not logged in")
	err := f.env().Ready(ctx, "v1.0.0-1", false)
	mustFail(t, f, "gh not signed in", err, "GitHub did not answer (is gh installed and signed in? gh auth login): gh auth status: not logged in")

	f, _, _ = ticketFixture(t)
	f.gh.milestonesFail = fmt.Errorf("gh: HTTP 401")
	env := f.env()
	env.Ticket = 1799
	err = env.Ready(ctx, "v1.0.0-1", false)
	mustFail(t, f, "gh failing with a ticket given", err, "GitHub did not answer")
	if !strings.Contains(f.out.String(), "ok       the release commits name #1799, the ticket given") {
		t.Fatalf("the ticket given is not asked of GitHub:\n%s", f.out.String())
	}
}

func TestReadyChecksTheTrunkOfAPullRequestFlow(t *testing.T) {
	f := makeFixture(t)
	mustRun(t, f, "ready --pr", f.env().Ready(context.Background(), "v1.0.0-1", true))
	if !strings.Contains(f.out.String(), "ok       rc-1.0.0 will be made from develop") {
		t.Fatalf("report:\n%s", f.out.String())
	}
	notCreated(t, f)
}
