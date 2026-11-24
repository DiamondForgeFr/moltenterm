// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// sameTreeOnDevelop gives develop a commit with the release commit's change but not the tagged commit, as
// SaaSFoundryAI's develop held after v1.3.0 (#2504).
func sameTreeOnDevelop(t *testing.T, f *fixture, tag string) {
	t.Helper()
	f.commitOnDevelop(t, "feat(#3): develop moved on")
	// -x: within the same second, a plain cherry-pick onto the same parent could be the very same commit.
	gitIn(t, f.checkout, "cherry-pick", "-x", f.originRef(t, tag+"^{commit}"))
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
}

func syncBackFixture(t *testing.T) (*fixture, *fakePrGitHub, *Env) {
	t.Helper()
	f := makeFixture(t)
	f.commitOnDevelop(t, "feat(#2): a feature")
	cutRelease(t, f, "v1.0.0-1")
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"pass"}, state: "CLEAN"}
	e := f.env()
	e.Run = gh.run
	return f, gh, e
}

// The trunk holds the release's change but not its history: sync-back brings the history back by the pull request of
// the release branch into the trunk, never an empty cherry-pick, and never says there is nothing to carry back.
func TestSyncBackBringsTheHistoryTheTrunkLacks(t *testing.T) {
	t.Parallel()
	f, gh, e := syncBackFixture(t)
	ctx := context.Background()
	sameTreeOnDevelop(t, f, "v1.0.0-1")
	f.out.Reset()

	mustRun(t, f, "sync-back", e.SyncBack(ctx, "v1.0.0-1"))
	out := f.out.String()
	if strings.Contains(out, "nothing to carry back") {
		t.Fatalf("sync-back skipped a trunk that lacks the tag:\n%s", out)
	}
	if gh.called("pr create --base develop --head main") != 1 || gh.called("pr create --base develop --head chore/") != 0 {
		t.Fatalf("sync-back must open the pull request of main into develop: %v", gh.calls)
	}
	if !strings.Contains(out, "with a merge commit, never squash or rebase") {
		t.Fatalf("sync-back must say how to merge:\n%s", out)
	}
	if len(gh.merges) != 0 {
		t.Fatalf("sync-back without --merge merged the pull request")
	}

	mustRun(t, f, "sync-back again", e.SyncBack(ctx, "v1.0.0-1"))
	if gh.called("pr create") != 1 {
		t.Fatalf("a second sync-back opened another pull request: %v", gh.calls)
	}
	mustRun(t, f, "sync-back --merge", e.SyncBackMerge(ctx, "v1.0.0-1"))
	if got := strings.Join(gh.merges[len(gh.merges)-1], " "); !strings.HasPrefix(got, "pr merge 10 --merge") {
		t.Fatalf("sync-back --merge must merge with a merge commit: %s", got)
	}
	gitIn(t, f.origin, "merge-base", "--is-ancestor", "v1.0.0-1", "develop")
	f.out.Reset()
	mustRun(t, f, "sync-back once merged", e.SyncBack(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "nothing to carry back") {
		t.Fatalf("once the tag is in develop's history, sync-back does nothing:\n%s", f.out.String())
	}
}

// When the release branch moved past the tag, its pull request would carry more than the release: sync-back stops and
// says to merge by hand with a merge commit.
func TestSyncBackStopsWhenTheReleaseBranchMovedOn(t *testing.T) {
	t.Parallel()
	f, gh, e := syncBackFixture(t)
	sameTreeOnDevelop(t, f, "v1.0.0-1")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	writeFile(t, filepath.Join(f.checkout, "hotfix.txt"), "x\n")
	gitIn(t, f.checkout, "add", "hotfix.txt")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "fix(#7): after the tag")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "HEAD:main")

	err := e.SyncBack(context.Background(), "v1.0.0-1")
	mustFail(t, f, "sync-back past the tag", err, "never squash or rebase")
	mustFail(t, f, "sync-back past the tag", err, "main moved past v1.0.0-1")
	if gh.called("pr create") != 0 {
		t.Fatalf("no pull request may be opened: %v", gh.calls)
	}
}

func TestSyncBackDoesNothingWhenTheTrunkHoldsTheTag(t *testing.T) {
	t.Parallel()
	f, gh, e := syncBackFixture(t)
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "develop", "origin/develop")
	gitIn(t, f.checkout, "merge", "--quiet", "--no-ff", "-m", "Merge main into develop", "origin/main")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	f.out.Reset()

	mustRun(t, f, "sync-back", e.SyncBack(context.Background(), "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "nothing to carry back") || gh.called("pr create") != 0 {
		t.Fatalf("sync-back did something although develop holds the tag:\n%s\n%v", f.out.String(), gh.calls)
	}
}

// The trunk lacks the release's change: the cherry-pick pull request opens, as before.
func TestSyncBackCherryPicksAMissingReleaseCommit(t *testing.T) {
	t.Parallel()
	f, gh, e := syncBackFixture(t)
	f.commitOnDevelop(t, "fix(#4): a fix merged during the release")
	f.out.Reset()

	mustRun(t, f, "sync-back", e.SyncBack(context.Background(), "v1.0.0-1"))
	if gh.called("pr create --base develop --head chore/sync-back-v1.0.0-1") != 1 || gh.called("pr create --base develop --head main") != 0 {
		t.Fatalf("sync-back must open the cherry-pick pull request: %v", gh.calls)
	}
	if got := f.originFile(t, "chore/sync-back-v1.0.0-1", "package.json"); !strings.Contains(got, `"1.0.0-1"`) {
		t.Fatalf("the sync-back branch does not carry the release commit:\n%s", got)
	}
	if !strings.Contains(f.out.String(), "never squash or rebase") {
		t.Fatalf("sync-back must say how to merge:\n%s", f.out.String())
	}
}
