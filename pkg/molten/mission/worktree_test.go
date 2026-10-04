// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestPaneFreshRequestsShareOneProbe(t *testing.T) {
	_, clone := makePaneRepo(t)
	var statuses atomic.Int32
	counting := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		for _, arg := range args {
			if arg == "status" {
				statuses.Add(1)
			}
		}
		return plainRunner(ctx, dir, name, args...)
	}
	panes := MakePanes(counting, nil, nil)
	panes.Get(PaneRequest{Dir: clone})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			panes.Get(PaneRequest{Dir: clone, Fresh: true})
		}()
	}
	wg.Wait()
	if statuses.Load() != 2 {
		t.Fatalf("four fresh requests together probed %d times after the first", statuses.Load()-1)
	}
}

func TestPaneLinkedThroughASymlink(t *testing.T) {
	base, _, tree := makeWorktreeFixture(t)
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(tree, alias); err != nil {
		t.Skip("no symlinks")
	}
	state, _ := MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: tree, Worktree: alias})
	if state.Linked == nil || state.Linked.Missing || !state.Linked.Inside {
		t.Fatalf("the same worktree spelled another way: %+v", state.Linked)
	}
}

func riskOf(plan WorktreePlan) *WorktreeRisk {
	return &WorktreeRisk{Sha: plan.Sha, ChangeCount: plan.ChangeCount, Unpushed: plan.Unpushed, IgnoredFileCount: plan.IgnoredFileCount}
}

func noTerminals(ctx context.Context, path string, exclude string) []WorktreeTerminal {
	return []WorktreeTerminal{}
}

// A clone of a develop-only origin, with a worktree on feature/5-x.
func makeWorktreeFixture(t *testing.T) (string, string, string) {
	t.Helper()
	base, clone := makePaneRepo(t)
	tree := filepath.Join(base, "wt")
	gitRun(t, clone, "worktree", "add", "-q", "-b", "feature/5-x", tree)
	return base, clone, tree
}

func TestPaneTellsWorktreesFromMainTrees(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	panes := MakePanes(plainRunner, nil, nil)
	main, _ := panes.Get(PaneRequest{Dir: clone})
	if main.Worktree {
		t.Fatalf("the main checkout read as a worktree: %+v", main)
	}
	wt, _ := panes.Get(PaneRequest{Dir: filepath.Join(tree, "."), Worktree: tree})
	if !wt.Worktree || wt.Root != tree {
		t.Fatalf("worktree: %+v", wt)
	}
	if wt.Linked == nil || wt.Linked.Missing || wt.Linked.Branch != "feature/5-x" {
		t.Fatalf("linked, in it: %+v", wt.Linked)
	}
	// The terminal went back to the main tree: its link still says which worktree it owns.
	back, _ := panes.Get(PaneRequest{Dir: clone, Worktree: tree})
	if back.Worktree || back.Linked == nil || back.Linked.Branch != "feature/5-x" || back.Linked.Missing {
		t.Fatalf("linked, outside it: %+v", back)
	}
	gitRun(t, clone, "worktree", "remove", tree)
	gone, _ := panes.Get(PaneRequest{Dir: clone, Worktree: tree})
	if gone.Linked == nil || !gone.Linked.Missing {
		t.Fatalf("removed outside MoltenTerm: %+v", gone.Linked)
	}
	// A link to the main tree is no worktree link.
	self, _ := panes.Get(PaneRequest{Dir: clone, Worktree: clone})
	if self.Linked == nil || !self.Linked.Missing {
		t.Fatalf("main tree as link: %+v", self.Linked)
	}
}

func TestPaneSubmoduleIsNoWorktree(t *testing.T) {
	base, clone := makePaneRepo(t)
	lib := filepath.Join(base, "lib")
	os.MkdirAll(lib, 0755)
	gitRun(t, lib, "init", "-q", "-b", "main")
	commit(t, lib, "l.txt", "lib")
	gitRun(t, clone, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib")
	state, _ := MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: filepath.Join(clone, "vendor", "lib")})
	if state.Worktree || state.Root != filepath.Join(clone, "vendor", "lib") {
		t.Fatalf("submodule: %+v", state)
	}
}

func TestWorktreePlanAndCleanRemoval(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(plainRunner, noTerminals)
	plan, err := w.Plan(WorktreeRequest{Dir: tree})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Missing || plan.Branch != "feature/5-x" || plan.ChangeCount != 0 || plan.Unpushed != 0 || plan.Trunk != "develop" {
		t.Fatalf("clean plan: %+v", plan)
	}
	if plan.Merged == nil || !*plan.Merged || plan.Protected {
		t.Fatalf("a branch with nothing new is merged: %+v", plan)
	}
	if mainPlan, err := w.Plan(WorktreeRequest{Dir: clone}); err == nil && !mainPlan.Missing {
		t.Fatal("the main tree was planned for removal")
	}
	if res, _ := w.Remove(WorktreeRemoveRequest{Dir: clone, Confirmed: &WorktreeRisk{}}); res.Removed {
		t.Fatal("the main tree was removed")
	}
	if _, err := os.Stat(filepath.Join(clone, "a.txt")); err != nil {
		t.Fatal("the main tree lost a file")
	}
	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree, DeleteBranch: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Removed || res.Forced || res.BranchDeleted != "feature/5-x" {
		t.Fatalf("clean removal: %+v", res)
	}
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatal("the worktree folder is still there")
	}
	again, _ := w.Plan(WorktreeRequest{Dir: tree})
	if !again.Missing {
		t.Fatalf("a removed worktree: %+v", again)
	}
	// Another terminal's close removed it first: nothing left to do, and nothing else removed.
	gone, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: &WorktreeRisk{}})
	if err != nil || gone.Removed || !gone.Gone {
		t.Fatalf("a second close: %+v %v", gone, err)
	}
}

func TestWorktreeWithWorkNeedsTheSecondConfirmation(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	commit(t, tree, "b.txt", "feat(#5): work")
	os.WriteFile(filepath.Join(tree, "draft.txt"), []byte("draft"), 0644)
	os.WriteFile(filepath.Join(tree, ".gitignore"), []byte(".env\n"), 0644)
	os.WriteFile(filepath.Join(tree, ".env"), []byte("SECRET=1"), 0644)
	w := MakeWorktrees(plainRunner, noTerminals)
	plan, err := w.Plan(WorktreeRequest{Dir: tree})
	if err != nil {
		t.Fatal(err)
	}
	if plan.ChangeCount != 2 || plan.Unpushed != 1 || plan.IgnoredCount != 1 || plan.IgnoredFileCount != 1 || plan.Ignored[0] != ".env" {
		t.Fatalf("work in progress: %+v", plan)
	}
	if plan.Merged == nil || *plan.Merged {
		t.Fatalf("a branch with new work is not merged: %+v", plan)
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, DeleteBranch: true}); err == nil {
		t.Fatal("removed without the second confirmation")
	}
	if _, err := os.Stat(filepath.Join(tree, "draft.txt")); err != nil {
		t.Fatal("the refused removal lost a file")
	}
	// A change made after the user confirmed is not covered by the confirmation.
	seen := riskOf(plan)
	os.WriteFile(filepath.Join(tree, "late.txt"), []byte("late"), 0644)
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: seen, DeleteBranch: true}); err == nil {
		t.Fatal("removed work the user never saw")
	}
	plan, _ = w.Plan(WorktreeRequest{Dir: tree})
	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: riskOf(plan), DeleteBranch: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Removed || !res.Forced || res.BranchDeleted != "" || !strings.Contains(res.BranchKept, "not merged") {
		t.Fatalf("confirmed removal: %+v", res)
	}
	g := &gitReader{ctx: context.Background(), run: plainRunner, dir: clone}
	if !g.refExists("refs/heads/feature/5-x") {
		t.Fatal("an unmerged branch was deleted")
	}
}

func TestWorktreeUnpushedOnlyStillAsks(t *testing.T) {
	_, _, tree := makeWorktreeFixture(t)
	commit(t, tree, "b.txt", "feat(#5): work")
	w := MakeWorktrees(plainRunner, noTerminals)
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree}); err == nil {
		t.Fatal("unpushed commits removed without the second confirmation")
	}
	plan, _ := w.Plan(WorktreeRequest{Dir: tree})
	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: riskOf(plan)})
	if err != nil || !res.Removed || res.Forced {
		t.Fatalf("clean but unpushed: %+v %v", res, err)
	}
}

func TestWorktreeLockedIsKept(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	gitRun(t, clone, "worktree", "lock", tree)
	w := MakeWorktrees(plainRunner, noTerminals)
	plan, _ := w.Plan(WorktreeRequest{Dir: tree})
	if !plan.Locked {
		t.Fatalf("locked: %+v", plan)
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: riskOf(plan)}); err == nil {
		t.Fatal("a locked worktree was removed")
	}
}

func TestChangePath(t *testing.T) {
	cases := map[string]string{
		"? new file.txt": "new file.txt",
		"! .env":         ".env",
		"1 .M N... 100644 100644 100644 abc abc src/a b.ts":               "src/a b.ts",
		"2 R. N... 100644 100644 100644 abc abc R100 new.ts\told.ts":      "new.ts",
		"u UU N... 100644 100644 100644 100644 abc abc abc conflicted.go": "conflicted.go",
	}
	for line, want := range cases {
		if got := changePath(line); got != want {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestWorktreeSharedOrIgnoredNeedsConfirmation(t *testing.T) {
	_, _, tree := makeWorktreeFixture(t)
	shared := MakeWorktrees(plainRunner, func(ctx context.Context, path string, exclude string) []WorktreeTerminal {
		return []WorktreeTerminal{{BlockId: "b2", Linked: true}}
	})
	if _, err := shared.Remove(WorktreeRemoveRequest{Dir: tree}); err == nil {
		t.Fatal("removed from under another terminal without the second confirmation")
	}
	os.WriteFile(filepath.Join(tree, ".gitignore"), []byte(".env\n"), 0644)
	gitRun(t, tree, "add", ".gitignore")
	gitRun(t, tree, "commit", "-q", "-m", "ignore")
	gitRun(t, tree, "push", "-q", "origin", "HEAD:feature/5-x")
	os.WriteFile(filepath.Join(tree, ".env"), []byte("SECRET=1"), 0644)
	w := MakeWorktrees(plainRunner, noTerminals)
	plan, _ := w.Plan(WorktreeRequest{Dir: tree})
	if plan.ChangeCount != 0 || plan.Unpushed != 0 || plan.IgnoredFileCount != 1 {
		t.Fatalf("only an ignored file: %+v", plan)
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree}); err == nil {
		t.Fatal("an ignored .env went without the second confirmation")
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: riskOf(plan)}); err != nil {
		t.Fatal(err)
	}
}

// A .git file pointing into a repository is not enough: git's records must name the folder back.
func TestWorktreeCraftedGitFileIsRefused(t *testing.T) {
	base, _, tree := makeWorktreeFixture(t)
	victim := filepath.Join(base, "victim")
	os.MkdirAll(victim, 0755)
	os.WriteFile(filepath.Join(victim, "precious.txt"), []byte("x"), 0644)
	admin, _ := os.ReadFile(filepath.Join(tree, ".git"))
	os.WriteFile(filepath.Join(victim, ".git"), admin, 0644)
	w := MakeWorktrees(plainRunner, noTerminals)
	if _, err := w.Plan(WorktreeRequest{Dir: victim}); err == nil {
		t.Fatal("a crafted .git file was taken for a worktree")
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: victim, Confirmed: &WorktreeRisk{}}); err == nil {
		t.Fatal("a crafted .git file led to a removal")
	}
	if _, err := os.Stat(filepath.Join(victim, "precious.txt")); err != nil {
		t.Fatal("the victim folder lost a file")
	}
}

func TestWorktreeRefusesHome(t *testing.T) {
	_, _, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(plainRunner, noTerminals)
	w.home = filepath.Join(tree, "home-of-someone")
	plan, err := w.Plan(WorktreeRequest{Dir: tree})
	if err != nil || plan.Refused == "" {
		t.Fatalf("a worktree holding the home folder: %+v %v", plan, err)
	}
	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: riskOf(plan)}); err == nil {
		t.Fatal("removed a folder holding the home folder")
	}
}
