// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A project has two places (FR-SHELL-105): its folder, which holds the context (a client's documents, mails, specs)
// and where the Files panel opens, and optionally one code repository inside it, where agents start and which the Git
// features read (Integration, Project, CI, the line map, the release notes). Without a repository of its own the
// folder is the repository, as before.

// must match the key in frontend/moltenterm-shell/workspace-project.ts
const ProjectRepoMetaKey = "molten:projectrepo"

// How far FindRepositories looks into the folder: a client folder keeps its repositories close to the top.
const (
	repoSearchDepth   = 3
	repoSearchMax     = 40
	repoSearchVisited = 4000
)

// Folders that never hold a project's own repository and can be huge.
var repoSearchSkip = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true, "out": true,
	"__pycache__": true, "venv": true, ".venv": true, ".cache": true, ".npm": true, ".gradle": true,
}

// ProjectRepoOf is the repository a project's Git features read: the chosen one when it lies inside the project's
// folder and is not the folder itself, else the folder.
func ProjectRepoOf(folder string, repo string) string {
	if folder == "" || repo == "" || !filepath.IsAbs(repo) {
		return folder
	}
	repo = filepath.Clean(repo)
	if repo == filepath.Clean(folder) || !CheckPathInside(repo, folder) {
		return folder
	}
	return repo
}

// WorkspaceRepo is ProjectRepoOf for a workspace's meta (its current project's live keys).
func WorkspaceRepo(meta waveobj.MetaMapType) string {
	return ProjectRepoOf(meta.GetString(ProjectMetaKey, ""), meta.GetString(ProjectRepoMetaKey, ""))
}

// WorkspaceRepoOfMap is WorkspaceRepo for a meta read over RPC.
func WorkspaceRepoOfMap(meta map[string]any) string {
	folder, _ := meta[ProjectMetaKey].(string)
	repo, _ := meta[ProjectRepoMetaKey].(string)
	return ProjectRepoOf(folder, repo)
}

func hasGitEntry(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// FindRepositories lists the Git repositories of a project folder: the folder alone when it is one, else the
// repositories found below it (a `.git` entry, a folder or a worktree's file), shallowest first, by path. A repository
// is not searched for further repositories, and symbolic links are not followed.
func FindRepositories(folder string) []string {
	folder = filepath.Clean(folder)
	if folder == "" || !filepath.IsAbs(folder) {
		return []string{}
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return []string{}
	}
	if hasGitEntry(folder) {
		return []string{folder}
	}
	found := []string{}
	visited := 0
	level := []string{folder}
	for depth := 0; depth < repoSearchDepth && len(level) > 0; depth++ {
		var next []string
		for _, dir := range level {
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				if entry.IsDir() && !repoSearchSkip[entry.Name()] && !strings.HasPrefix(entry.Name(), ".") {
					names = append(names, entry.Name())
				}
			}
			sort.Strings(names)
			for _, name := range names {
				visited++
				if visited > repoSearchVisited {
					return found
				}
				child := filepath.Join(dir, name)
				if hasGitEntry(child) {
					found = append(found, child)
					if len(found) >= repoSearchMax {
						return found
					}
					continue
				}
				next = append(next, child)
			}
		}
		level = next
	}
	return found
}
