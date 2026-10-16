// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Step 3 of the first run, "Your project and your sessions" (FR-ONB-004, DS-ONB-004), proposes the git repositories
// found up to four levels deep under the home folder (#749: ~/Documents/Projects/<repo> is three). The scan runs once
// per wavesrv process, in wavesrv, so the renderer never walks the disk.

// must match frontend/moltenterm-onboarding/onboarding-project-model.ts
const ProjectsCommand = "onboardingprojects"

const MaxProjectCandidates = 12
const projectScanDepth = 4

// A home folder with a huge tree must not keep the step waiting: the walk is breadth first, so whatever these bounds
// cut is the deepest folders, and what was found so far is still offered.
const projectScanTimeout = 3 * time.Second
const projectScanMaxDirs = 20000

// Folders that hold no project of the user's, or too many folders to walk. Dot folders are skipped too.
var projectScanSkips = map[string]bool{
	"Library":          true,
	"Applications":     true,
	"AppData":          true,
	"node_modules":     true,
	"bower_components": true,
	"vendor":           true,
	"Pods":             true,
	"target":           true,
	"venv":             true,
	"__pycache__":      true,
	"site-packages":    true,
	"go":               true,
	"snap":             true,
	"Pictures":         true,
	"Music":            true,
	"Movies":           true,
	"Videos":           true,
}

type ProjectCandidate struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	ModTime int64  `json:"modtime"`
}

type ProjectScanLimits struct {
	Depth   int
	Limit   int
	MaxDirs int
}

type projectScanDir struct {
	path  string
	depth int
}

var projectScanOnce sync.Once
var projectScanResult []ProjectCandidate

func isGitRepo(dir string) (int64, bool) {
	gitPath := filepath.Join(dir, ".git")
	info, err := os.Stat(gitPath)
	if err != nil {
		return 0, false
	}
	mod := info.ModTime()
	if head, err := os.Stat(filepath.Join(gitPath, "HEAD")); err == nil && head.ModTime().After(mod) {
		mod = head.ModTime()
	}
	return mod.UnixMilli(), true
}

// ScanProjects lists the git repositories at most limits.Depth levels under home, a repository's own subfolders
// aside, most recently changed first. It stops early when ctx ends or after limits.MaxDirs folders (0: no bound).
func ScanProjects(ctx context.Context, home string, limits ProjectScanLimits) []ProjectCandidate {
	found := []ProjectCandidate{}
	if home == "" {
		return found
	}
	queue := []projectScanDir{{path: home, depth: limits.Depth}}
	visited := 0
	for len(queue) > 0 && ctx.Err() == nil {
		if limits.MaxDirs > 0 && visited >= limits.MaxDirs {
			break
		}
		dir := queue[0]
		queue = queue[1:]
		visited++
		entries, err := os.ReadDir(dir.path)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !entry.IsDir() || strings.HasPrefix(name, ".") || projectScanSkips[name] {
				continue
			}
			child := filepath.Join(dir.path, name)
			if mod, ok := isGitRepo(child); ok {
				found = append(found, ProjectCandidate{Path: child, Name: name, ModTime: mod})
				continue
			}
			if dir.depth > 1 {
				queue = append(queue, projectScanDir{path: child, depth: dir.depth - 1})
			}
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].ModTime > found[j].ModTime })
	if len(found) > limits.Limit {
		found = found[:limits.Limit]
	}
	return found
}

func handleProjects(ctx context.Context, source string, data any) (any, error) {
	projectScanOnce.Do(func() {
		home, err := os.UserHomeDir()
		if err != nil {
			projectScanResult = []ProjectCandidate{}
			return
		}
		scanCtx, cancel := context.WithTimeout(context.Background(), projectScanTimeout)
		defer cancel()
		projectScanResult = ScanProjects(scanCtx, home, ProjectScanLimits{
			Depth:   projectScanDepth,
			Limit:   MaxProjectCandidates,
			MaxDirs: projectScanMaxDirs,
		})
	})
	return map[string]any{"projects": projectScanResult}, nil
}

func init() {
	HandleCommand(ProjectsCommand, handleProjects)
}
