// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"path/filepath"
	"strings"
)

// ProjectDirOf is the project folder an agent in a terminal belongs to: the workspace's project when the terminal's
// folder is in it (or unknown), else the folder's git root, else the folder. A linked worktree belongs to its main
// checkout (#1123): the merge queue's agent works in a tree under MoltenTerm's data folder, and its worktree's name is
// never its project. The hand-offs name an agent's project with it (FR-CONT-015), and a first name locked for a project
// (FR-CONT-014, #2324) is keyed by it.
func ProjectDirOf(folder string, project string) string {
	if project != "" && (folder == "" || projectWithin(folder, project)) {
		return project
	}
	if folder == "" {
		return ""
	}
	root := FindGitRoot(folder)
	if root == "" {
		return folder
	}
	main := MainCheckoutOfTree(root)
	if main == "" {
		return root
	}
	if project != "" && sameProjectPath(main, project) {
		return project
	}
	return main
}

func projectWithin(path string, dir string) bool {
	if dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func sameProjectPath(a string, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}
