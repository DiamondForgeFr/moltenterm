// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os/exec"
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
