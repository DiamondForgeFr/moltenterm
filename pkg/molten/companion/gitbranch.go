// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"strings"
)

// An agent's branch is read from its own folder on disk (#967): Claude Code records on every line a branch that one
// process shares across all its worktrees, so a sub-agent's transcript names whichever worktree last switched branch.

const (
	// A repository's root is looked for this many folders up at most.
	maxGitDirDepth = 40
	maxGitFileSize = 4096
)

// FolderBranch reads the branch checked out in the repository or worktree holding dir; "" when dir is in none, when
// HEAD is detached or unreadable. No git command runs.
func FolderBranch(dir string) string {
	if dir == "" || !filepath.IsAbs(dir) {
		return ""
	}
	gitDir := findGitDir(filepath.Clean(dir))
	if gitDir == "" {
		return ""
	}
	head, ok := readSmallFile(filepath.Join(gitDir, "HEAD"))
	if !ok {
		return ""
	}
	ref, ok := strings.CutPrefix(strings.TrimSpace(head), "ref:")
	if !ok {
		return ""
	}
	branch, ok := strings.CutPrefix(strings.TrimSpace(ref), "refs/heads/")
	if !ok || branch == "" {
		return ""
	}
	return cutString(branch, 300)
}

// findGitDir finds the git folder of the repository holding dir: a .git folder, or a worktree's .git file pointing
// to its folder under the main repository.
func findGitDir(dir string) string {
	for i := 0; i < maxGitDirDepth; i++ {
		dotGit := filepath.Join(dir, ".git")
		if info, err := os.Lstat(dotGit); err == nil {
			if info.IsDir() {
				return dotGit
			}
			if !info.Mode().IsRegular() {
				return ""
			}
			text, ok := readSmallFile(dotGit)
			if !ok {
				return ""
			}
			target, ok := strings.CutPrefix(strings.TrimSpace(text), "gitdir:")
			if !ok {
				return ""
			}
			target = strings.TrimSpace(target)
			if !filepath.IsAbs(target) {
				target = filepath.Join(dir, target)
			}
			return filepath.Clean(target)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

func readSmallFile(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxGitFileSize {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}
