// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Worktree per terminal (FR-SHELL-016, DS-SHELL-016): a terminal can be linked to the git worktree its task runs in.
// The link is the worktree's top folder in the block's meta; wavesrv tells each terminal which tree its folder is in
// (pkg/molten/mission/pane.go). MoltenTerm never creates a worktree: an agent or the user does, then links it.

const (
	// must match frontend/moltenterm-shell/worktree-model.ts
	WorktreeMetaKey          = "molten:worktree"
	WorktreeDismissedMetaKey = "molten:worktreedismissed"

	worktreeGitTimeout = 10 * time.Second
)

// IsWorktreeCheckout tells whether root holds a .git file, the mark of a linked worktree (or of a submodule, which
// git then tells apart).
func IsWorktreeCheckout(root string) bool {
	info, err := os.Stat(filepath.Join(root, ".git"))
	return err == nil && info.Mode().IsRegular()
}

// ParseGitDirs reads `git rev-parse --path-format=absolute --git-dir --git-common-dir`. The tree is a linked worktree
// when the two differ; a submodule has a .git file too, with both the same.
func ParseGitDirs(out string) (string, string, bool) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return "", "", false
	}
	gitDir := filepath.Clean(strings.TrimSpace(lines[0]))
	common := filepath.Clean(strings.TrimSpace(lines[1]))
	if gitDir == "" || common == "" || !filepath.IsAbs(gitDir) || !filepath.IsAbs(common) {
		return "", "", false
	}
	return gitDir, common, gitDir != common
}

// MainCheckoutOf is the folder of the repository a worktree belongs to: the parent of its common .git folder, or the
// common folder itself for a bare repository.
func MainCheckoutOf(common string) string {
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common)
	}
	return common
}

type WorktreeInfo struct {
	Path   string `json:"path"`
	Main   string `json:"main"`
	Branch string `json:"branch,omitempty"`
}

// ResolveWorktree finds the linked worktree that holds dir (`molten worktree link`). The path kept is the one the
// user knows (git would answer with symlinks resolved, /private/tmp for /tmp on macOS).
func ResolveWorktree(dir string) (WorktreeInfo, error) {
	if !filepath.IsAbs(dir) {
		return WorktreeInfo{}, fmt.Errorf("%s is not an absolute path", dir)
	}
	root := FindGitRoot(filepath.Clean(dir))
	if root == "" {
		return WorktreeInfo{}, fmt.Errorf("%s is not in a git repository", dir)
	}
	if !IsWorktreeCheckout(root) {
		return WorktreeInfo{}, fmt.Errorf("%s is the main tree of its repository, not a linked worktree", root)
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeGitTimeout)
	defer cancel()
	out, err := runGit(ctx, root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
	if err != nil {
		return WorktreeInfo{}, err
	}
	_, common, linked := ParseGitDirs(out)
	if !linked {
		return WorktreeInfo{}, fmt.Errorf("%s is not a linked worktree (a submodule?)", root)
	}
	info := WorktreeInfo{Path: root, Main: MainCheckoutOf(common)}
	info.Branch, _ = runGit(ctx, root, "symbolic-ref", "--short", "-q", "HEAD")
	return info, nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// WorktreeMissing tells a link whose worktree is gone (removed outside MoltenTerm): no folder, or no .git file in it.
func WorktreeMissing(path string) bool {
	return !IsWorktreeCheckout(path)
}
