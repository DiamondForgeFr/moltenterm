// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
)

// What the Leftovers group's request to an owner (#1143, pkg/molten/review) reads again on its own, never trusting a
// window's word: the project's linked worktree, its lock, and the lock's live owner.

var (
	ErrTreeNotLinked = errors.New("the worktree is not one of the project's linked worktrees")
	ErrLockNotLive   = errors.New("the worktree's lock is not held by a running process")
)

// LinkedTree is one of the project's linked worktrees as git lists it.
type LinkedTree struct {
	Path       string
	Branch     string
	Locked     bool
	LockReason string
}

// LinkedTreeOf finds the linked worktree at path; false when git no longer lists it (the main checkout never counts).
func LinkedTreeOf(ctx context.Context, run Runner, dir string, path string) (LinkedTree, bool, error) {
	trees, err := listTrees(&gitReader{ctx: ctx, run: run, dir: dir})
	if err != nil {
		return LinkedTree{}, false, err
	}
	tree, found := linkedTreeIn(trees, path)
	return tree, found, nil
}

func linkedTreeIn(trees []treeEntry, path string) (LinkedTree, bool) {
	want := realPath(path)
	for i, tree := range trees {
		if i == 0 || tree.path != want {
			continue
		}
		return LinkedTree{Path: tree.path, Branch: tree.branch, Locked: tree.locked, LockReason: tree.lockReason}, true
	}
	return LinkedTree{}, false
}

// LiveLockOwner reads the worktree's lock again and names its live owner as the Leftovers group does.
func LiveLockOwner(ctx context.Context, run Runner, dir string, path string) (LeftoverOwner, LinkedTree, error) {
	g := &gitReader{ctx: ctx, run: run, dir: dir}
	trees, err := listTrees(g)
	if err != nil {
		return LeftoverOwner{}, LinkedTree{}, err
	}
	tree, found := linkedTreeIn(trees, path)
	if !found {
		return LeftoverOwner{}, LinkedTree{}, ErrTreeNotLinked
	}
	holder, ok := ParseLockReason(tree.LockReason)
	if !tree.Locked || !ok || !holderRuns(holder) {
		return LeftoverOwner{}, tree, ErrLockNotLive
	}
	places := liveAgentPlaces(ctx)
	agents := MatchBranchAgents(trees, places)
	agents = append(agents, SubagentBranchAgents(trees, agents, liveSubagents(places))...)
	return ResolveLockOwner(holder, tree.Path, places, agents, LiveProcFacts()), tree, nil
}
