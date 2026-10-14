// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"strings"
)

// What the cleanup after a review merge (FR-REV-013, pkg/molten/review) reuses of Mission Control: the terminals working
// in a worktree and the content check of branch cleaning.

// WorktreeTerminalsOf lists the open terminals linked to the worktree or working in it.
func WorktreeTerminalsOf(ctx context.Context, path string) []WorktreeTerminal {
	return openWorktreeTerminals(ctx, path, nil)
}

// BranchContentOn tells whether ref's code is all on targetRef: merging it would change nothing, or every commit of it
// has an equivalent there (a rebase merge whose re-merge conflicts with later edits). nil when git could not say.
func BranchContentOn(ctx context.Context, run Runner, dir string, targetRef string, ref string) *bool {
	g := &gitReader{ctx: ctx, run: run, dir: dir}
	tree, err := g.out("rev-parse", targetRef+"^{tree}")
	if err != nil || !treeIdRegex.MatchString(strings.TrimSpace(tree)) {
		return nil
	}
	onTarget := contentOnTrunk(g, strings.TrimSpace(tree), targetRef, ref)
	if onTarget == nil || *onTarget {
		return onTarget
	}
	if patches := patchesOnTrunk(g, targetRef, ref); patches != nil && *patches {
		return patches
	}
	return onTarget
}
