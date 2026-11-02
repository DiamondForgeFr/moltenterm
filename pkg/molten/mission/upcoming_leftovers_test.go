// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeCommit(t *testing.T, dir string, files map[string]string, subject string) string {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		gitRun(t, dir, "add", name)
	}
	gitRun(t, dir, "commit", "-q", "-m", subject)
	return gitIn(t, dir, "rev-parse", "HEAD")
}

const lockStart = "Sun Oct 25 16:46:51 2026"

func TestParseLockReason(t *testing.T) {
	holder, ok := ParseLockReason("claude agent agent-ac88 (pid 44215 start " + lockStart + ")")
	at, _ := time.ParseInLocation(lockStartLayout, lockStart, time.Local)
	if !ok || holder.Pid != 44215 || holder.StartMs != at.UnixMilli() {
		t.Fatalf("Claude Code's lock: %+v %v", holder, ok)
	}
	if holder, ok := ParseLockReason("other tool, pid 12"); !ok || holder.Pid != 12 || holder.StartMs != 0 {
		t.Fatalf("a pid without a start: %+v", holder)
	}
	for _, reason := range []string{"", "on a removable disk", "pid x", "pid 0", "rapid 12"} {
		if _, ok := ParseLockReason(reason); ok {
			t.Fatalf("%q names no process", reason)
		}
	}
}

// #1121 (FR-REV-022 AC15): a closed PR whose branch's content reached the base by another commit is a leftover, one
// with real work stays Upcoming; a worktree locked by a process that ended is offered, one locked by a running process
// keeps its leftover hidden, one locked with no pid is offered as held; a pr<N> copy of a merged PR and the PR's review
// worktree join its card, a copy with its own commit does not.
func TestUpcomingExtraLeftovers(t *testing.T) {
	dir := makeGitFlowRepo(t)
	// 40: closed, its change reached develop inside a bigger commit (another patch id).
	gitRun(t, dir, "checkout", "-q", "-b", "feature/40-copied", "develop")
	copied := writeCommit(t, dir, map[string]string{"x.txt": "x\n"}, "feat: x")
	gitRun(t, dir, "checkout", "-q", "develop")
	writeCommit(t, dir, map[string]string{"x.txt": "x\n", "y.txt": "y\n"}, "feat: x and y")
	// 41: closed with work develop does not have.
	work := branchWithCommit(t, dir, "feature/41-work", "w.txt")
	// 42, 43, 44: merged, each in a locked worktree.
	ended := branchWithCommit(t, dir, "feature/42-ended", "e.txt")
	squashInto(t, dir, "feature/42-ended")
	live := branchWithCommit(t, dir, "feature/43-live", "l.txt")
	squashInto(t, dir, "feature/43-live")
	held := branchWithCommit(t, dir, "feature/44-held", "h.txt")
	squashInto(t, dir, "feature/44-held")
	trees := t.TempDir()
	for _, b := range []struct{ name, branch, reason string }{
		{"ended", "feature/42-ended", "claude agent agent-1 (pid 90001 start " + lockStart + ")"},
		{"live", "feature/43-live", "claude agent agent-2 (pid 90002 start " + lockStart + ")"},
		{"held", "feature/44-held", ""},
	} {
		path := filepath.Join(trees, b.name)
		gitRun(t, dir, "worktree", "add", "-q", path, b.branch)
		if b.reason == "" {
			gitRun(t, dir, "worktree", "lock", path)
		} else {
			gitRun(t, dir, "worktree", "lock", "--reason", b.reason, path)
		}
	}
	restore := SetLockHolderCheck(func(pid int32, startMs int64) bool { return pid == 90002 })
	defer restore()
	// 45: merged, its branch deleted; pr45 copies its head, pr-46 adds a commit to 46's head.
	copyHead := branchWithCommit(t, dir, "feature/45-gone", "g.txt")
	squashInto(t, dir, "feature/45-gone")
	gitRun(t, dir, "branch", "-q", "pr45", copyHead)
	gitRun(t, dir, "branch", "-q", "-D", "feature/45-gone")
	head46 := branchWithCommit(t, dir, "feature/46-more", "m.txt")
	squashInto(t, dir, "feature/46-more")
	gitRun(t, dir, "branch", "-q", "-D", "feature/46-more")
	gitRun(t, dir, "checkout", "-q", "-b", "pr-46", head46)
	commit(t, dir, "m2.txt", "feat: not in 46")
	gitRun(t, dir, "checkout", "-q", "develop")
	// 47: merged outside Validate, its review worktree left.
	head47 := branchWithCommit(t, dir, "feature/47-reviewed", "r.txt")
	squashInto(t, dir, "feature/47-reviewed")
	gitRun(t, dir, "branch", "-q", "-D", "feature/47-reviewed")
	reviewDir := filepath.Join(t.TempDir(), "worktrees", "proj-1234")
	reviewTree := filepath.Join(reviewDir, "review-47")
	gitRun(t, dir, "worktree", "add", "-q", "--detach", reviewTree, head47)

	prs := []string{
		closedPrJson(140, "feature/40-copied", copied, false),
		closedPrJson(141, "feature/41-work", work, false),
		closedPrJson(142, "feature/42-ended", ended, true),
		closedPrJson(143, "feature/43-live", live, true),
		closedPrJson(144, "feature/44-held", held, true),
		closedPrJson(45, "feature/45-gone", copyHead, true),
		closedPrJson(46, "feature/46-more", head46, true),
		closedPrJson(47, "feature/47-reviewed", head47, true),
	}
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r",
		Prs: json.RawMessage("[]"), Merged: json.RawMessage("[" + strings.Join(prs, ",") + "]")}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	u := MakeUpcoming(UpcomingEnv{
		Run:            run,
		Snapshot:       func(string) (Snapshot, bool) { return snap, true },
		ReviewTreesDir: func(string) string { return reviewDir },
		Procs: func() ProcFacts {
			return fakeProcs{names: map[int32]string{90002: "claude"}, cwds: map[int32]string{90002: "/w"}}
		},
	})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	upcoming := map[string]UpcomingBranch{}
	for _, b := range answer.Branches {
		upcoming[b.Branch] = b
	}
	leftovers := map[int]UpcomingLeftover{}
	for _, l := range answer.Leftovers {
		leftovers[l.Pr] = l
	}
	if l, ok := leftovers[140]; !ok || l.State != UpcomingAfterClosed || l.Base != answer.Target || !l.Local {
		t.Fatalf("a closed PR whose content is on the base: %+v", l)
	}
	if _, ok := upcoming["feature/40-copied"]; ok {
		t.Fatalf("a closed leftover is not Upcoming")
	}
	if b, ok := upcoming["feature/41-work"]; !ok || b.AfterState != UpcomingAfterClosed {
		t.Fatalf("a closed PR with work stays Upcoming: %+v", answer.Branches)
	}
	if _, ok := leftovers[141]; ok {
		t.Fatalf("a closed PR with work is no leftover")
	}
	if l := leftovers[142]; l.Lock != LeftoverLockEnded || l.LockPid != 90001 || l.State != UpcomingAfterMerged {
		t.Fatalf("a lock whose holder ended: %+v", l)
	}
	for _, a := range answer.Agents {
		if a.Branch == "feature/42-ended" {
			t.Fatalf("a worktree whose locking session ended has no background agent: %+v", a)
		}
	}
	// #1143: a lock whose holder runs lists its leftover with that owner, here a process no terminal runs.
	if l := leftovers[143]; l.Lock != LeftoverLockLive || l.LockPid != 90002 || l.Owner == nil || l.Owner.Via != OwnerViaProcess ||
		l.Owner.Process != "claude" || l.Owner.Folder != "/w" || l.Owner.Reachable() {
		t.Fatalf("a lock whose holder runs names its owner: %+v %+v", l, l.Owner)
	}
	if l := leftovers[144]; l.Lock != LeftoverLockHeld {
		t.Fatalf("a lock naming no pid: %+v", l)
	}
	if l := leftovers[45]; len(l.Copies) != 1 || l.Copies[0] != "pr45" || l.Local || l.Worktree != "" || l.Branch != "feature/45-gone" {
		t.Fatalf("a pr<N> copy of a merged PR: %+v", l)
	}
	if l, ok := leftovers[46]; ok {
		t.Fatalf("a copy holding its own commit stays: %+v", l)
	}
	if l := leftovers[47]; l.ReviewTree != realPath(reviewTree) || len(l.Copies) != 0 {
		t.Fatalf("the review worktree of a PR merged outside Validate: %+v", l)
	}
	if len(answer.Leftovers) != 6 {
		t.Fatalf("leftovers: %+v", answer.Leftovers)
	}
}

// CommitsNotOn judges by content: a copy that landed in a bigger commit is on the target, a commit whose lines the
// target changed since (a conflict on replay) is not, nor is a new file.
func TestCommitsNotOn(t *testing.T) {
	dir := makeGitFlowRepo(t)
	ctx := context.Background()
	gitRun(t, dir, "checkout", "-q", "-b", "copied", "develop")
	writeCommit(t, dir, map[string]string{"x.txt": "1\n2\n3\n"}, "x")
	gitRun(t, dir, "checkout", "-q", "develop")
	writeCommit(t, dir, map[string]string{"x.txt": "1\n2\n3\n", "y.txt": "y\n"}, "x and y")
	if notOn, ok := CommitsNotOn(ctx, plainRunner, dir, "develop", "copied"); !ok || len(notOn) != 0 {
		t.Fatalf("copied: %v %v", notOn, ok)
	}
	gitRun(t, dir, "checkout", "-q", "-b", "edited", "develop")
	edited := writeCommit(t, dir, map[string]string{"x.txt": "1\nbranch\n3\n"}, "edit")
	gitRun(t, dir, "checkout", "-q", "develop")
	writeCommit(t, dir, map[string]string{"x.txt": "1\nbase\n3\n"}, "edit on develop")
	if notOn, ok := CommitsNotOn(ctx, plainRunner, dir, "develop", "edited"); !ok || len(notOn) != 1 || notOn[0] != edited {
		t.Fatalf("edited: %v %v", notOn, ok)
	}
	if notOn, ok := CommitsNotOn(ctx, plainRunner, dir, "develop", "feature/4-thing"); !ok || len(notOn) != 1 {
		t.Fatalf("new file: %v %v", notOn, ok)
	}
}
