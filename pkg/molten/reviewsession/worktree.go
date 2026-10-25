// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The review worktree (DS-REV-004, #505 Q4): a linked worktree of the project that has the PR's head branch checked
// out (the agent's) is read as it is; otherwise MoltenTerm keeps a detached worktree of the head commit under its data
// folder, <data>/molten/worktrees/<project>/review-<N>. The developer's checkout is never switched, and the diff is
// always computed from commit ids, so an agent's uncommitted edits never show in the review.

// GitRunner runs git in dir and returns its output (mission.ExecRunner in wavesrv).
type GitRunner func(ctx context.Context, dir string, args ...string) ([]byte, error)

var oidPattern = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// validRef accepts a branch name git could hold and no shell or git option could be made of.
func validRef(ref string) bool {
	if ref == "" || len(ref) > 255 || strings.HasPrefix(ref, "-") || strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") {
		return false
	}
	if strings.Contains(ref, "..") || strings.Contains(ref, "@{") || strings.HasSuffix(ref, ".lock") {
		return false
	}
	for _, r := range ref {
		if r <= ' ' || r == 0x7f || strings.ContainsRune(`~^:?*[\`, r) {
			return false
		}
	}
	return true
}

// ReviewTreesDir is the folder of a project's review worktrees.
func ReviewTreesDir(dataDir string, projectDir string) string {
	return molten.ReviewTreesDir(dataDir, projectDir)
}

// ReviewTreeDir is the detached worktree of PR number of the project.
func ReviewTreeDir(dataDir string, projectDir string, number int) string {
	return filepath.Join(ReviewTreesDir(dataDir, projectDir), "review-"+strconv.Itoa(number))
}

type worktreeEntry struct {
	path   string
	branch string
}

// parseWorktrees reads `git worktree list --porcelain`; the first entry is the main checkout.
func parseWorktrees(out string) []worktreeEntry {
	var rtn []worktreeEntry
	var cur *worktreeEntry
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			rtn = append(rtn, worktreeEntry{path: path})
			cur = &rtn[len(rtn)-1]
			continue
		}
		if cur == nil {
			continue
		}
		if branch, ok := strings.CutPrefix(line, "branch "); ok {
			cur.branch = branch
		}
	}
	return rtn
}

// resolveHead returns the PR's head commit: the given one when the project has it (fetched once otherwise), else the
// branch's tip on origin, else the local branch.
func resolveHead(ctx context.Context, git GitRunner, projectDir string, headRef string, headOid string) (string, error) {
	hasCommit := func(oid string) bool {
		_, err := git(ctx, projectDir, "cat-file", "-e", oid+"^{commit}")
		return err == nil
	}
	if headOid != "" {
		if !oidPattern.MatchString(headOid) {
			return "", uimsg.Errorf(uimsg.Make("review.headnotcommit", "head", headOid), "the head commit %q is not a commit id", headOid)
		}
		if hasCommit(headOid) {
			return headOid, nil
		}
		git(ctx, projectDir, "fetch", "--quiet", "origin", "refs/heads/"+headRef)
		if hasCommit(headOid) {
			return headOid, nil
		}
		return "", uimsg.Errorf(uimsg.Make("review.headmissing", "head", headOid[:12], "branch", headRef), "the PR's head commit %s is not in the project, even after a fetch of %s", headOid[:12], headRef)
	}
	git(ctx, projectDir, "fetch", "--quiet", "origin", "refs/heads/"+headRef)
	for _, ref := range []string{"refs/remotes/origin/" + headRef, "refs/heads/" + headRef} {
		out, err := git(ctx, projectDir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
		if oid := strings.TrimSpace(string(out)); err == nil && oidPattern.MatchString(oid) {
			return oid, nil
		}
	}
	return "", uimsg.Errorf(uimsg.Make("review.branchmissing", "branch", headRef), "the branch %s was not found in the project or on origin", headRef)
}

// ResolveHead is resolveHead for the Review tab's diff (pkg/molten/review).
func ResolveHead(ctx context.Context, git GitRunner, projectDir string, headRef string, headOid string) (string, error) {
	return resolveHead(ctx, git, projectDir, headRef, headOid)
}

// ValidRef is validRef for the Review tab's diff.
func ValidRef(ref string) bool {
	return validRef(ref)
}

// IsOid tells whether s is a full commit or blob id.
func IsOid(s string) bool {
	return oidPattern.MatchString(s)
}

// ResolveWorktree returns the folder the session runs in and what it is (mcpreview.WorktreeAgent or WorktreeReview).
func ResolveWorktree(ctx context.Context, git GitRunner, dataDir string, projectDir string, number int, headRef string, headOid string) (string, string, error) {
	out, err := git(ctx, projectDir, "worktree", "list", "--porcelain")
	if err != nil {
		return "", "", fmt.Errorf("the project's worktrees could not be listed: %w", err)
	}
	entries := parseWorktrees(string(out))
	for i, e := range entries {
		// The main checkout is the developer's own: it may switch branches under the review at any time.
		if i == 0 || e.branch != "refs/heads/"+headRef {
			continue
		}
		if info, err := os.Stat(e.path); err == nil && info.IsDir() {
			return e.path, mcpreview.WorktreeAgent, nil
		}
	}
	tree := ReviewTreeDir(dataDir, projectDir, number)
	if err := checkoutReviewTree(ctx, git, dataDir, projectDir, tree, headOid); err != nil {
		return "", "", err
	}
	return tree, mcpreview.WorktreeReview, nil
}

// checkoutReviewTree creates the detached review worktree at headOid, or moves it there. The project's git hooks do
// not run: the checkout is MoltenTerm's, not the developer's.
func checkoutReviewTree(ctx context.Context, git GitRunner, dataDir string, projectDir string, tree string, headOid string) error {
	noHooks := filepath.Join(dataDir, "molten", "worktrees", "nohooks")
	if err := os.MkdirAll(noHooks, 0700); err != nil {
		return err
	}
	hooks := []string{"-c", "core.hooksPath=" + noHooks}
	// A .git file whose .git/worktrees/<name> was pruned still stats fine, but every checkout in it fails.
	_, statErr := os.Stat(filepath.Join(tree, ".git"))
	if statErr == nil {
		_, statErr = git(ctx, tree, "rev-parse", "--git-dir")
	}
	if statErr == nil {
		if _, err := git(ctx, tree, append(hooks, "checkout", "--quiet", "--detach", "--force", headOid)...); err != nil {
			return fmt.Errorf("the review worktree could not move to %s: %w", headOid[:12], err)
		}
		return nil
	}
	os.RemoveAll(tree)
	git(ctx, projectDir, "worktree", "prune")
	if err := os.MkdirAll(filepath.Dir(tree), 0700); err != nil {
		return err
	}
	if _, err := git(ctx, projectDir, append(hooks, "worktree", "add", "--quiet", "--detach", "--force", tree, headOid)...); err != nil {
		return fmt.Errorf("the review worktree could not be created: %w", err)
	}
	return nil
}
