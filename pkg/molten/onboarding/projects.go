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
)

// Step 3 of the first run, "Your project and your sessions" (FR-ONB-004, DS-ONB-004), proposes the git repositories
// found two levels deep under the home folder. The scan runs once per wavesrv process, in wavesrv, so the renderer
// never walks the disk.

// must match frontend/moltenterm-onboarding/onboarding-project-model.ts
const ProjectsCommand = "onboardingprojects"

const MaxProjectCandidates = 12
const projectScanDepth = 2

// Folders that hold no project of the user's, or too many folders to walk.
var projectScanSkips = map[string]bool{
	"Library":      true,
	"Applications": true,
	"node_modules": true,
	"go":           true,
	"snap":         true,
	"Pictures":     true,
	"Music":        true,
	"Movies":       true,
}

type ProjectCandidate struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	ModTime int64  `json:"modtime"`
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

func scanDir(dir string, depth int, out *[]ProjectCandidate) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || strings.HasPrefix(name, ".") || projectScanSkips[name] {
			continue
		}
		child := filepath.Join(dir, name)
		if mod, ok := isGitRepo(child); ok {
			*out = append(*out, ProjectCandidate{Path: child, Name: name, ModTime: mod})
			continue
		}
		if depth > 1 {
			scanDir(child, depth-1, out)
		}
	}
}

// ScanProjects lists the git repositories at most depth levels under home, a repository's own subfolders aside, most
// recently changed first.
func ScanProjects(home string, depth int, limit int) []ProjectCandidate {
	found := []ProjectCandidate{}
	if home == "" {
		return found
	}
	scanDir(home, depth, &found)
	sort.SliceStable(found, func(i, j int) bool { return found[i].ModTime > found[j].ModTime })
	if len(found) > limit {
		found = found[:limit]
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
		projectScanResult = ScanProjects(home, projectScanDepth, MaxProjectCandidates)
	})
	return map[string]any{"projects": projectScanResult}, nil
}

func init() {
	HandleCommand(ProjectsCommand, handleProjects)
}
