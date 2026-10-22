// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestBranchesPlanNamesTheTerminalsHoldingAWorktree(t *testing.T) {
	f := makeOwnTreeFixture(t)
	plan, err := f.r.PlanBranches(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range plan.Branches {
		switch b.Name {
		case "feature/12-tree":
			if len(b.Terminals) != 1 || b.Terminals[0].BlockId != "block-12" || b.Terminals[0].Tab != "Review" {
				t.Errorf("the kept branch names its terminal: %+v", b.Terminals)
			}
		default:
			if len(b.Terminals) != 0 {
				t.Errorf("%s names no terminal: %+v", b.Name, b.Terminals)
			}
		}
	}
}

func closerOf(f ownTreeFixture, closed *[]string) TerminalCloser {
	return func(ctx context.Context, blockId string) error {
		*closed = append(*closed, blockId)
		delete(f.terms, blockId)
		return nil
	}
}

func TestCloseAndCleanBranchClosesTheSessionThenCleans(t *testing.T) {
	f := makeOwnTreeFixture(t)
	var closed []string
	res, err := f.r.CloseAndCleanBranch(BranchesCloseRequest{Dir: f.dir, Name: "feature/12-tree", BlockIds: []string{"block-12"}}, closerOf(f, &closed))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(closed, ",") != "block-12" {
		t.Fatalf("the confirmed terminal is closed: %v", closed)
	}
	if strings.Join(res.Deleted, ",") != "feature/12-tree" || res.Failed != 0 {
		t.Fatalf("clean: %+v", res)
	}
	if _, err := os.Stat(f.tree(12)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the worktree is gone: %v", err)
	}
	if strings.Contains(gitIn(t, f.dir, "branch", "-a"), "feature/12-tree") {
		t.Fatal("the branch is gone")
	}
}

func TestCloseAndCleanBranchRefusesATerminalOpenedSince(t *testing.T) {
	f := makeOwnTreeFixture(t)
	f.terms["block-new"] = WorktreeTerminal{BlockId: "block-new", Tab: "Later"}
	var closed []string
	_, err := f.r.CloseAndCleanBranch(BranchesCloseRequest{Dir: f.dir, Name: "feature/12-tree", BlockIds: []string{"block-12"}}, closerOf(f, &closed))
	if err == nil || len(closed) != 0 {
		t.Fatalf("nothing is closed when another terminal opened: %v, %v", err, closed)
	}
	if _, err := os.Stat(f.tree(12)); err != nil {
		t.Fatalf("the worktree stays: %v", err)
	}
}

func TestCloseAndCleanBranchNeverClosesForUncommittedWork(t *testing.T) {
	f := makeOwnTreeFixture(t)
	var closed []string
	res, err := f.r.CloseAndCleanBranch(BranchesCloseRequest{Dir: f.dir, Name: "feature/11-tree", BlockIds: []string{"block-12"}}, closerOf(f, &closed))
	if err != nil {
		t.Fatal(err)
	}
	if len(closed) != 0 || len(res.Deleted) != 0 || res.Failed != 1 || !strings.Contains(res.Errors[0], BranchKeepTreeChanges) {
		t.Fatalf("a worktree with uncommitted work stays, nothing closed: %+v, %v", res, closed)
	}
	if _, err := os.Stat(f.tree(11)); err != nil {
		t.Fatalf("the worktree stays: %v", err)
	}
}

func TestTreePrsReadsTheMergedPullRequestOfABranch(t *testing.T) {
	f := makeOwnTreeFixture(t)
	calls := 0
	git := f.r.git
	p := MakeTreePrs(func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" && args[0] == "pr" {
			calls++
		}
		return git(ctx, d, name, args...)
	})
	now := time.Now()
	p.now = func() time.Time { return now }
	req := TreePrsRequest{Trees: []TreeBranch{
		{Path: f.tree(12), Branch: "feature/12-tree"},
		{Path: f.dir, Branch: "feature/15-extra"},
		{Path: f.dir, Branch: "-x"},
		{Path: "relative", Branch: "feature/12-tree"},
	}}
	res, err := p.Read(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Merged) != 1 || res.Merged[0].Branch != "feature/12-tree" || res.Merged[0].Pr != 12 {
		t.Fatalf("only the branch whose head its PR merged is marked: %+v", res.Merged)
	}
	if calls != 2 {
		t.Fatalf("GitHub is asked once per valid branch: %d", calls)
	}
	p.Read(req)
	if calls != 2 {
		t.Fatalf("both answers are remembered for a while: %d", calls)
	}
	now = now.Add(treePrsUnmergedTtl + time.Second)
	p.Read(req)
	if calls != 3 {
		t.Fatalf("the unmerged branch is asked again once its answer is old: %d", calls)
	}
}
