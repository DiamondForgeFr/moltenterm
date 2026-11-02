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

const (
	// More commits than this off the target are not judged one by one: git could not say in time, so they stay.
	commitsNotOnMax = 50
	// More changed files than this are not compared file by file.
	filesOnMax = 500
)

// CommitsNotOn lists ref's commits whose change is not on targetRef (#1121), judged by content only, since a squash,
// a rebase or a copy that resolved conflicts gives the target other commit ids: the branch is on the target when
// merging it changes nothing, or when the target holds the branch's version of every file it changed; otherwise each
// commit off the target is, when its patch id is there (git cherry), or when replaying it on the target changes
// nothing. A merge commit is replayed from its first parent. ok false when git could not tell.
func CommitsNotOn(ctx context.Context, run Runner, dir string, targetRef string, ref string) ([]string, bool) {
	if on := BranchContentOn(ctx, run, dir, targetRef, ref); on != nil && *on {
		return []string{}, true
	}
	g := &gitReader{ctx: ctx, run: run, dir: dir}
	if filesOn(g, targetRef, ref) {
		return []string{}, true
	}
	targetTree, err := g.out("rev-parse", targetRef+"^{tree}")
	targetTree = strings.TrimSpace(targetTree)
	if err != nil || !treeIdRegex.MatchString(targetTree) {
		return nil, false
	}
	out, err := g.out("rev-list", "--reverse", targetRef+".."+ref)
	if err != nil {
		return nil, false
	}
	commits := strings.Fields(out)
	if len(commits) > commitsNotOnMax {
		return nil, false
	}
	cherry, err := g.out("cherry", targetRef, ref)
	if err != nil {
		return nil, false
	}
	equivalent := map[string]bool{}
	for _, line := range strings.Split(cherry, "\n") {
		if sha, ok := strings.CutPrefix(strings.TrimSpace(line), "- "); ok {
			equivalent[sha] = true
		}
	}
	rtn := []string{}
	for _, sha := range commits {
		if !treeIdRegex.MatchString(sha) {
			return nil, false
		}
		if equivalent[sha] || replaysToNothing(g, targetRef, targetTree, sha) {
			continue
		}
		rtn = append(rtn, sha)
	}
	return rtn, true
}

// filesOn: the target holds ref's version of every file ref changed since they parted (a deleted file is absent from
// both).
func filesOn(g *gitReader, targetRef string, ref string) bool {
	base, err := g.out("merge-base", targetRef, ref)
	base = strings.TrimSpace(base)
	if err != nil || !treeIdRegex.MatchString(base) {
		return false
	}
	out, err := g.out("diff", "--name-only", "-z", "--no-renames", base, ref)
	if err != nil {
		return false
	}
	var files []string
	for _, f := range strings.Split(out, "\x00") {
		if f != "" {
			files = append(files, f)
		}
	}
	if len(files) == 0 || len(files) > filesOnMax {
		return len(files) == 0
	}
	args := append([]string{"--literal-pathspecs", "diff", "--quiet", "--no-renames", targetRef, ref, "--"}, files...)
	_, err = g.out(args...)
	return err == nil
}

// replaysToNothing: cherry-picking the commit on the target (a three-way merge from its first parent) is clean and
// leaves the target's tree as it is.
func replaysToNothing(g *gitReader, targetRef string, targetTree string, sha string) bool {
	parent, err := g.out("rev-parse", "--verify", "--quiet", sha+"^1")
	parent = strings.TrimSpace(parent)
	if err != nil || !treeIdRegex.MatchString(parent) {
		return false
	}
	out, err := g.out("merge-tree", "--write-tree", "--merge-base="+parent, targetRef, sha)
	if err != nil {
		return false
	}
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0]) == targetTree
}
