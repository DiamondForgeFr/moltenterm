// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// What the line map (FR-MC-022) reads from the collector: the long-lived branches' commits with their parents and
// author date, and the trunk's merges walked back to where each branch left.

func makeMergeRepo(t *testing.T) string {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "develop")
	commit(t, dir, "a.txt", "feat(#1): first")
	commit(t, dir, "b.txt", "feat(#2): second")
	gitRun(t, dir, "checkout", "-q", "-b", "feature/3-thing")
	commit(t, dir, "c.txt", "feat(#3): thing")
	commit(t, dir, "d.txt", "fix(#3): thing again")
	gitRun(t, dir, "checkout", "-q", "develop")
	commit(t, dir, "e.txt", "docs: on develop meanwhile")
	gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "Merge branch 'feature/3-thing' into develop", "feature/3-thing")
	return dir
}

func TestCollectGitMerges(t *testing.T) {
	dir := makeMergeRepo(t)
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Merges) != 1 {
		t.Fatalf("merges: %+v", snap.Merges)
	}
	merge := snap.Merges[0]
	if merge.Subject != "Merge branch 'feature/3-thing' into develop" || merge.Commits != 2 || merge.FirstDate == "" {
		t.Fatalf("merge: %+v", merge)
	}
	develop := snap.Branches[0]
	if develop.Name != "develop" || len(develop.Commits) != 4 {
		t.Fatalf("develop: %+v", develop)
	}
	// develop's first-parent history, newest first: the merge, the docs commit, #2, #1. The branch left at #2.
	if merge.Fork == nil || merge.Fork.Sha != develop.Commits[2].Sha {
		t.Fatalf("fork: %+v, develop %+v", merge.Fork, develop.Commits)
	}
	if len(develop.Commits[0].Parents) != 2 || develop.Commits[0].AuthorDate == "" {
		t.Fatalf("merge commit parents and author date: %+v", develop.Commits[0])
	}
}

func TestCollectGitLinearHasNoMerges(t *testing.T) {
	dir := makeGitFlowRepo(t)
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Merges == nil || len(snap.Merges) != 0 {
		t.Fatalf("a linear history has no merge: %+v", snap.Merges)
	}
	for _, b := range snap.Branches[:2] {
		for _, c := range b.Commits {
			if c.AuthorDate == "" || (len(c.Parents) != 1 && c.Subject != "feat(#1): first") {
				t.Fatalf("%s commit %+v", b.Name, c)
			}
		}
	}
	feature := snap.Branches[2]
	if feature.Commits[0].Parents != nil || feature.Commits[0].AuthorDate != "" {
		t.Fatalf("a feature branch's commits stay light: %+v", feature.Commits[0])
	}
}

func TestParseHistoryKeepsTabsInSubjects(t *testing.T) {
	commits := parseHistory([]string{"abc\t2026-10-01T10:00:00+02:00\t2026-09-30T09:00:00+02:00\tp1 p2\tMerge\tit", "short"})
	if len(commits) != 1 || commits[0].Subject != "Merge\tit" || strings.Join(commits[0].Parents, ",") != "p1,p2" {
		t.Fatalf("history: %+v", commits)
	}
	root := parseHistory([]string{"abc\t2026-10-01T10:00:00+02:00\t2026-10-01T10:00:00+02:00\t\troot"})
	if len(root) != 1 || len(root[0].Parents) != 0 || root[0].Subject != "root" {
		t.Fatalf("root commit: %+v", root)
	}
}

func TestEarlierDateAcrossOffsets(t *testing.T) {
	if !earlierDate("2026-10-01T10:00:00+02:00", "2026-10-01T09:30:00+00:00") {
		t.Fatal("08:00 UTC is before 09:30 UTC")
	}
	if earlierDate("garbage", "2026-10-01T09:30:00+00:00") {
		t.Fatal("an unreadable date is never earlier")
	}
}

// The agent tool's worktree branches (#1123): one still on the commit its worktree started from is noise and is left
// out, even when that commit is ahead of the trunk (a release branch's); one with commits of its own stays, marked.
func TestCollectGitLeavesOutEmptyAgentBranches(t *testing.T) {
	dir := makeMergeRepo(t)
	gitRun(t, dir, "checkout", "-q", "-b", "main")
	commit(t, dir, "r.txt", "chore(release): v1")
	gitRun(t, dir, "branch", "worktree-agent-a1")
	gitRun(t, dir, "branch", "worktree-agent-a2")
	gitRun(t, dir, "checkout", "-q", "-b", "worktree-agent-b1")
	commit(t, dir, "w.txt", "feat(#9): the agent's own work")
	gitRun(t, dir, "checkout", "-q", "develop")
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]Branch{}
	for _, b := range snap.Branches {
		names[b.Name] = b
	}
	if _, ok := names["worktree-agent-a1"]; ok {
		t.Errorf("an empty agent branch is listed: %+v", names["worktree-agent-a1"])
	}
	if _, ok := names["worktree-agent-a2"]; ok {
		t.Errorf("a second empty agent branch on the same commit is listed")
	}
	own, ok := names["worktree-agent-b1"]
	if !ok || !own.AgentTree || len(own.Commits) == 0 {
		t.Errorf("the agent branch with its own commit: %+v (listed %v)", own, ok)
	}
	if f, ok := names["feature/3-thing"]; !ok || f.AgentTree {
		t.Errorf("a feature branch: %+v (listed %v)", f, ok)
	}
	if _, ok := names["main"]; !ok {
		t.Errorf("main is missing: %v", names)
	}
}

// The agent tool's isolation (#1133): worktree-agent-x starts on main's release commit, which develop lacks, then its
// worktree checks out feature/9-x from develop. The row is feature/9-x, once it has a commit, and it names its
// worktree; worktree-agent-x and a branch holding only an rc branch's commits are not drawn, while a branch with
// commits on neither long-lived branch still is.
func TestCollectGitNamesTheWorktreeBranchNotTheAgentBranch(t *testing.T) {
	dir := makeMergeRepo(t)
	manifest := `{"mainBranch":"main","workflow":{"workingBranch":"develop","branchNaming":{"release":"rc-{version}"}}}`
	if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "checkout", "-q", "-b", "main")
	commit(t, dir, "r.txt", "chore(release): v1.0.0-6 (rc)")
	gitRun(t, dir, "branch", "worktree-agent-x")
	gitRun(t, dir, "checkout", "-q", "-b", "rc-1.0.0", "develop")
	commit(t, dir, "v.txt", "chore(release): bump to 1.0.0")
	gitRun(t, dir, "branch", "fix/11-from-rc")
	gitRun(t, dir, "checkout", "-q", "-b", "feature/10-own", "develop")
	commit(t, dir, "o.txt", "feat(#10): work of its own")
	gitRun(t, dir, "checkout", "-q", "develop")
	tree := filepath.Join(t.TempDir(), "agent-x")
	gitRun(t, dir, "worktree", "add", "-q", tree, "worktree-agent-x")
	gitRun(t, tree, "checkout", "-q", "-b", "feature/9-x", "develop")

	read := func() map[string]Branch {
		snap, err := CollectGit(context.Background(), plainRunner, dir, false)
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]Branch{}
		for _, b := range snap.Branches {
			names[b.Name] = b
		}
		return names
	}
	names := read()
	if b, ok := names["worktree-agent-x"]; ok {
		t.Errorf("the agent branch on main's release commit is listed: %+v", b)
	}
	if b := names["feature/9-x"]; len(b.Commits) != 0 {
		t.Errorf("feature/9-x before its first commit: %+v", b)
	}
	if b := names["fix/11-from-rc"]; len(b.Commits) != 0 {
		t.Errorf("a branch holding only the rc branch's commits: %+v", b)
	}
	if b := names["feature/10-own"]; len(b.Commits) != 1 || b.Worktree != "" {
		t.Errorf("a branch with its own commit, in no worktree: %+v", b)
	}
	if b := names["rc-1.0.0"]; len(b.Commits) != 1 {
		t.Errorf("the rc branch keeps its own commit: %+v", b)
	}

	commit(t, tree, "n.txt", "feat(#9): the agent's work")
	names = read()
	b, ok := names["feature/9-x"]
	if !ok || len(b.Commits) != 1 || b.AgentTree {
		t.Fatalf("feature/9-x with a commit: %+v (listed %v)", b, ok)
	}
	if filepath.Base(b.Worktree) != "agent-x" {
		t.Errorf("feature/9-x's worktree: %q", b.Worktree)
	}
	if _, ok := names["worktree-agent-x"]; ok {
		t.Errorf("the agent branch is listed once its worktree moved on")
	}
	if d := names["develop"]; d.Worktree != "" {
		t.Errorf("the main checkout is named: %+v", d.Worktree)
	}
}
