// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func closedPrJson(number int, branch string, head string, merged bool) string {
	state, mergedAt := "CLOSED", "null"
	if merged {
		state, mergedAt = "MERGED", `"2026-10-25T11:43:00Z"`
	}
	return fmt.Sprintf(`{"number":%d,"title":"pr %d","url":"https://github.com/o/r/pull/%d","state":%q,"headRefName":%q,"headRefOid":%q,`+
		`"baseRefName":"develop","isCrossRepository":false,"mergedAt":%s,"closedAt":"2026-10-25T11:43:00Z"}`,
		number, number, number, state, branch, head, mergedAt)
}

// branchWithCommit makes a ticket branch off develop with one commit and returns its head.
func branchWithCommit(t *testing.T, dir string, branch string, file string) string {
	t.Helper()
	gitRun(t, dir, "checkout", "-q", "-b", branch, "develop")
	commit(t, dir, file, "feat: "+branch)
	head := gitIn(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "checkout", "-q", "develop")
	return head
}

func squashInto(t *testing.T, dir string, branch string) {
	t.Helper()
	gitRun(t, dir, "merge", "-q", "--squash", branch)
	gitRun(t, dir, "commit", "-q", "-m", "squash "+branch)
}

// #1088 (FR-REV-022 AC14): a merged PR's branch with nothing after its head is a leftover, whether GitHub squashed it
// (its commits stay "ahead" of develop) or merged it with a merge commit (an agent on it kept it listed); commits after
// the merged head keep it Upcoming with the count; a PR closed without merging keeps its branch Upcoming, worded.
func TestUpcomingMergedBranchesAreLeftovers(t *testing.T) {
	dir := makeGitFlowRepo(t)
	squashed := branchWithCommit(t, dir, "feature/31-squash", "s.txt")
	squashInto(t, dir, "feature/31-squash")
	merged := branchWithCommit(t, dir, "feature/32-merge", "m.txt")
	gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "merge 32", "feature/32-merge")
	after := branchWithCommit(t, dir, "feature/33-after", "a.txt")
	squashInto(t, dir, "feature/33-after")
	gitRun(t, dir, "checkout", "-q", "feature/33-after")
	commit(t, dir, "a2.txt", "feat: follow-up")
	gitRun(t, dir, "checkout", "-q", "develop")
	closed := branchWithCommit(t, dir, "feature/34-closed", "c.txt")
	branchWithCommit(t, dir, "feature/35-foreign", "f.txt")
	squashInto(t, dir, "feature/35-foreign")
	treeSquash := filepath.Join(t.TempDir(), "squash")
	treeMerge := filepath.Join(t.TempDir(), "merge")
	gitRun(t, dir, "worktree", "add", "-q", treeSquash, "feature/31-squash")
	gitRun(t, dir, "worktree", "add", "-q", treeMerge, "feature/32-merge")

	prs := []string{
		closedPrJson(131, "feature/31-squash", squashed, true),
		closedPrJson(132, "feature/32-merge", merged, true),
		closedPrJson(133, "feature/33-after", after, true),
		closedPrJson(134, "feature/34-closed", closed, false),
		// Pushed from another clone: its head is unknown here, its content is on develop.
		closedPrJson(135, "feature/35-foreign", "0123456789abcdef0123456789abcdef01234567", true),
		// An older PR of the same branch: the newest one decides.
		strings.Replace(closedPrJson(90, "feature/34-closed", closed, true), "2026-10-25T11:43:00Z", "2026-10-20T08:00:00Z", 2),
	}
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r",
		Prs: json.RawMessage("[]"), Merged: json.RawMessage("[" + strings.Join(prs, ",") + "]")}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	places := []AgentPlace{{BlockId: "b1", Agent: "claude", FirstName: "Camille", Cwd: realPath(treeMerge), Started: 1}}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return places },
	})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	upcoming := map[string]UpcomingBranch{}
	for _, b := range answer.Branches {
		upcoming[b.Branch] = b
	}
	leftovers := map[string]UpcomingLeftover{}
	for _, l := range answer.Leftovers {
		leftovers[l.Branch] = l
	}
	for _, branch := range []string{"feature/31-squash", "feature/32-merge", "feature/35-foreign"} {
		if _, ok := upcoming[branch]; ok {
			t.Fatalf("%s: a merged PR's branch is never Upcoming: %+v", branch, upcoming[branch])
		}
	}
	if l := leftovers["feature/31-squash"]; l.Pr != 131 || l.Ticket != 31 || l.Worktree != realPath(treeSquash) || !l.Local || l.Remote || l.Title != "pr 131" {
		t.Fatalf("squash merge leftover: %+v", l)
	}
	if l := leftovers["feature/32-merge"]; l.Pr != 132 || l.Worktree != realPath(treeMerge) {
		t.Fatalf("merge commit leftover, its agent on it: %+v", l)
	}
	if l := leftovers["feature/35-foreign"]; l.Pr != 135 {
		t.Fatalf("an unknown head compared by content: %+v", l)
	}
	if b := upcoming["feature/33-after"]; b.AfterPr != 133 || b.AfterState != UpcomingAfterMerged || b.AfterCount != 1 {
		t.Fatalf("commits after the merged head stay Upcoming: %+v", b)
	}
	if b := upcoming["feature/34-closed"]; b.AfterPr != 134 || b.AfterState != UpcomingAfterClosed || b.AfterCount != 0 || b.Ahead != 1 {
		t.Fatalf("a PR closed without merging: %+v", b)
	}
	if b := upcoming["feature/4-thing"]; b.AfterPr != 0 || b.AfterState != "" {
		t.Fatalf("a branch without a closed PR: %+v", b)
	}
	if len(answer.Leftovers) != 3 {
		t.Fatalf("leftovers: %+v", answer.Leftovers)
	}
}

func TestClosedPrsByBranchWithoutTheRead(t *testing.T) {
	gh := &GithubSnapshot{State: GithubStateOk, Merged: json.RawMessage(`[` + closedPrJson(1, "feature/1-a", "aaaaaaa", true) + `]`), Errors: map[string]string{"merged": "boom"}}
	if got := closedPrsByBranch(Snapshot{Github: gh}); got != nil {
		t.Fatalf("a failed read tells nothing: %+v", got)
	}
	gh.Errors = nil
	if got := closedPrsByBranch(Snapshot{Github: gh}); got["feature/1-a"].Number != 1 {
		t.Fatalf("read: %+v", got)
	}
}
