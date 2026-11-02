// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// #1122: the merge queue's worktrees go when nothing would be lost, its earlier ones included, with real git.

type treeFixture struct {
	t      *testing.T
	origin string
	dir    string
	data   string
	runner *BatchRunner
	inUse  map[string]bool
}

func newTreeFixture(t *testing.T) *treeFixture {
	t.Helper()
	root := t.TempDir()
	f := &treeFixture{t: t, origin: filepath.Join(root, "origin.git"), dir: filepath.Join(root, "project"),
		data: filepath.Join(root, "data"), inUse: map[string]bool{}}
	fgit(t, root, "init", "-q", "--bare", "-b", "develop", f.origin)
	fgit(t, root, "clone", "-q", f.origin, f.dir)
	fgit(t, f.dir, "checkout", "-q", "-b", "develop")
	if err := os.WriteFile(filepath.Join(f.dir, "f"), []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, f.dir, "add", "-A")
	fgit(t, f.dir, "commit", "-q", "-m", "base")
	fgit(t, f.dir, "push", "-q", "origin", "develop")
	fgit(t, f.dir, "fetch", "-q", "origin")
	restarter := MakeRestarter(MakeStore(f.data), RestartEnv{Git: batchTestGit, DataDir: f.data})
	f.runner = MakeBatchRunner(BatchEnv{Agents: restarter, DataDir: f.data,
		TreeInUse: func(path string) bool { return f.inUse[filepath.Base(path)] }})
	return f
}

func (f *treeFixture) run() BatchRun {
	return BatchRun{Id: "run-now", Dir: f.dir, Base: "develop"}
}

// addTree adds a detached worktree named name in the project's review worktrees folder, on origin/develop.
func (f *treeFixture) addTree(name string) string {
	f.t.Helper()
	parent := reviewsession.ReviewTreesDir(f.data, f.dir)
	if err := os.MkdirAll(parent, 0700); err != nil {
		f.t.Fatal(err)
	}
	tree := filepath.Join(parent, name)
	fgit(f.t, f.dir, "worktree", "add", "--detach", "-q", tree, "origin/develop")
	return tree
}

// commitIn commits a change of file in the tree and returns the commit.
func (f *treeFixture) commitIn(tree string, file string, content string) string {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(tree, file), []byte(content), 0644); err != nil {
		f.t.Fatal(err)
	}
	fgit(f.t, tree, "add", "-A")
	fgit(f.t, tree, "commit", "-q", "-m", "work in "+filepath.Base(tree))
	return fgit(f.t, tree, "rev-parse", "HEAD")
}

func (f *treeFixture) trees() []string {
	f.t.Helper()
	var rtn []string
	for _, line := range strings.Split(fgit(f.t, f.dir, "worktree", "list", "--porcelain"), "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			rtn = append(rtn, filepath.Base(path))
		}
	}
	return rtn[1:]
}

func (f *treeFixture) workKept(tree string, heads []string) string {
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	return f.runner.treeWorkKept(ctx, tree, heads, []string{"develop"})
}

// The gold's case: the agent pushed the PR's rebased head, GitHub squash-merged it and deleted the branch, and a
// fetch --prune dropped it from refs/remotes. The head the queue pushed is safe; an unknown one is not.
func TestBatchTreeOfASquashMergedPrIsNotUnpushed(t *testing.T) {
	f := newTreeFixture(t)
	tree := f.addTree(batchTreeName)
	head := f.commitIn(tree, "g", "agent's rebase\n")
	fgit(t, tree, "push", "-q", "origin", "HEAD:refs/heads/feature/7-seven")
	fgit(t, f.dir, "fetch", "-q", "origin")
	fgit(t, f.dir, "push", "-q", "origin", "--delete", "feature/7-seven")
	fgit(t, f.dir, "fetch", "-q", "--prune", "origin")
	if kept := f.workKept(tree, nil); kept != BatchKeptUnpushed {
		t.Fatalf("a head no remote has, unknown to the queue: kept %q, want unpushed", kept)
	}
	if kept := f.workKept(tree, []string{head}); kept != "" {
		t.Fatalf("the head the queue pushed is on GitHub: kept %q", kept)
	}
	run := BatchRun{Base: "develop", Items: []BatchItem{{BatchPr: BatchPr{Number: 7}, Head: head}}}
	if heads := runHeads(run); !slices.Equal(heads, []string{head}) {
		t.Fatalf("run heads %v", heads)
	}
}

// A commit whose content reached the base another way (a squash merge) loses nothing.
func TestBatchTreeWhoseContentIsOnTheBaseGoes(t *testing.T) {
	f := newTreeFixture(t)
	tree := f.addTree(batchTreeName)
	f.commitIn(tree, "g", "same content\n")
	if err := os.WriteFile(filepath.Join(f.dir, "g"), []byte("same content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, f.dir, "add", "-A")
	fgit(t, f.dir, "commit", "-q", "-m", "squashed")
	fgit(t, f.dir, "push", "-q", "origin", "develop")
	fgit(t, f.dir, "fetch", "-q", "origin")
	if kept := f.workKept(tree, nil); kept != "" {
		t.Fatalf("the content is on develop: kept %q", kept)
	}
}

func TestBatchTreeWithWorkStays(t *testing.T) {
	f := newTreeFixture(t)
	dirty := f.addTree(batchTreeName)
	if err := os.WriteFile(filepath.Join(dirty, "notes.txt"), []byte("mine\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if kept := f.workKept(dirty, nil); kept != BatchKeptChanges {
		t.Fatalf("an untracked file: kept %q, want changes", kept)
	}
	rebasing := f.addTree(batchTreeName + "-2")
	f.commitIn(rebasing, "f", "a\nmine\nc\n")
	fgit(t, f.dir, "checkout", "-q", "develop")
	if err := os.WriteFile(filepath.Join(f.dir, "f"), []byte("a\ntheirs\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, f.dir, "commit", "-q", "-am", "theirs")
	fgit(t, f.dir, "push", "-q", "origin", "develop")
	fgit(t, rebasing, "fetch", "-q", "origin")
	if _, err := batchTestGit(context.Background(), rebasing, "rebase", "origin/develop"); err == nil {
		t.Fatalf("the rebase should stop on the conflict")
	}
	if kept := f.workKept(rebasing, nil); kept != BatchKeptRebasing {
		t.Fatalf("a rebase stopped halfway: kept %q, want rebasing", kept)
	}
}

// A leftover batch-merge goes before the next tree is made, which takes batch-merge again; the ones holding work or
// in use stay, each with why; trees that are not the queue's and the current run's tree are never touched.
func TestBatchSweepRemovesOnlyEarlierTreesWithNothingToLose(t *testing.T) {
	f := newTreeFixture(t)
	f.addTree(batchTreeName)
	dirty := f.addTree(batchTreeName + "-2")
	if err := os.WriteFile(filepath.Join(dirty, "notes.txt"), []byte("mine\n"), 0644); err != nil {
		t.Fatal(err)
	}
	locked := f.addTree(batchTreeName + "-3")
	fgit(t, f.dir, "worktree", "lock", locked)
	f.addTree(batchTreeName + "-4")
	f.inUse[batchTreeName+"-4"] = true
	unpushed := f.addTree(batchTreeName + "-5")
	f.commitIn(unpushed, "h", "not pushed\n")
	current := f.addTree(batchTreeName + "-6")
	f.addTree("review-7")
	f.addTree(batchTreeName + "-old")
	gone := f.addTree(batchTreeName + "-8")
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	kept := f.runner.sweepTrees(ctx, f.run(), current)
	want := []BatchTree{
		{Path: filepath.Base(dirty), Kept: BatchKeptChanges},
		{Path: filepath.Base(locked), Kept: BatchKeptLocked},
		{Path: batchTreeName + "-4", Kept: BatchKeptInUse},
		{Path: filepath.Base(unpushed), Kept: BatchKeptUnpushed},
	}
	for i := range kept {
		kept[i].Path = filepath.Base(kept[i].Path)
	}
	slices.SortFunc(kept, func(a, b BatchTree) int { return strings.Compare(a.Path, b.Path) })
	if !slices.Equal(kept, want) {
		t.Fatalf("kept %+v, want %+v", kept, want)
	}
	trees := f.trees()
	slices.Sort(trees)
	wantTrees := []string{batchTreeName + "-2", batchTreeName + "-3", batchTreeName + "-4", batchTreeName + "-5",
		batchTreeName + "-6", batchTreeName + "-old", "review-7"}
	if !slices.Equal(trees, wantTrees) {
		t.Fatalf("worktrees %v, want %v", trees, wantTrees)
	}
	if !pathExists(current) {
		t.Fatalf("the current run's tree was touched")
	}
	tree, err := f.runner.makeTree(f.run())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(tree) != batchTreeName {
		t.Fatalf("the next tree is %s, want %s", filepath.Base(tree), batchTreeName)
	}
}

// The heads of the project's earlier queues, kept in MoltenTerm's data folder, make their trees safe too.
func TestBatchSweepKnowsTheEarlierQueuesHeads(t *testing.T) {
	f := newTreeFixture(t)
	tree := f.addTree(batchTreeName)
	head := f.commitIn(tree, "g", "pushed then merged\n")
	earlier := BatchRun{Id: "run-before", Dir: f.dir, Base: "main", State: BatchDone,
		Items: []BatchItem{{BatchPr: BatchPr{Number: 3, HeadRef: "feature/3", HeadOid: head}, State: BatchItemMerged, Head: head}}}
	f.runner.save(earlier)
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	if kept := f.runner.sweepTrees(ctx, f.run(), ""); len(kept) != 0 {
		t.Fatalf("kept %+v", kept)
	}
	if trees := f.trees(); len(trees) != 0 {
		t.Fatalf("worktrees left %v", trees)
	}
}

// A terminal of MoltenTerm open in an earlier tree keeps it.
func TestBatchSweepKeepsATreeWithATerminal(t *testing.T) {
	f := newTreeFixture(t)
	tree := f.addTree(batchTreeName)
	f.runner.env.Agents.env.Terminals = func(ctx context.Context, path string) []mission.WorktreeTerminal {
		if samePath(path, tree) {
			return []mission.WorktreeTerminal{{BlockId: "block-1"}}
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	kept := f.runner.sweepTrees(ctx, f.run(), "")
	if len(kept) != 1 || kept[0].Kept != BatchKeptInUse || !pathExists(tree) {
		t.Fatalf("kept %+v", kept)
	}
}

// End to end: a clean batch-merge left by an earlier run goes, the run's agent takes batch-merge, and after the run no
// queue tree is left.
func TestBatchRunReusesBatchMergeAndLeavesNoTree(t *testing.T) {
	f := newBatchFixture(t, nil)
	parent := reviewsession.ReviewTreesDir(f.data, f.dir)
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	fgit(t, f.dir, "worktree", "add", "--detach", "-q", filepath.Join(parent, batchTreeName), "origin/develop")
	f.start(2, 3)
	run := f.waitEnd()
	if run.State != BatchDone || filepath.Base(run.Worktree) != batchTreeName {
		t.Fatalf("state %s, worktree %s, want %s", run.State, run.Worktree, batchTreeName)
	}
	if !run.Cleaned || len(run.Stale) != 0 {
		t.Fatalf("cleaned %v, kept %q, stale %+v", run.Cleaned, run.Kept, run.Stale)
	}
	if list := fgit(t, f.dir, "worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
		t.Fatalf("worktrees left:\n%s", list)
	}
}
