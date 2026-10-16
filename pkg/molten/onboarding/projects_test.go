// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func makeRepo(t *testing.T, dir string, mod time.Time) {
	t.Helper()
	git := filepath.Join(dir, ".git")
	if err := os.MkdirAll(git, 0755); err != nil {
		t.Fatal(err)
	}
	head := filepath.Join(git, "HEAD")
	if err := os.WriteFile(head, []byte("ref: refs/heads/main\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(git, mod, mod); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(head, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func TestScanProjects(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	makeRepo(t, filepath.Join(home, "old"), now.Add(-48*time.Hour))
	makeRepo(t, filepath.Join(home, "code", "recent"), now.Add(-time.Hour))
	makeRepo(t, filepath.Join(home, "code", "recent", "nested"), now)
	makeRepo(t, filepath.Join(home, "a", "b", "toodeep"), now)
	makeRepo(t, filepath.Join(home, ".hidden"), now)
	makeRepo(t, filepath.Join(home, "Library", "repo"), now)
	makeRepo(t, filepath.Join(home, "x", "node_modules"), now)

	ctx := context.Background()
	got := ScanProjects(ctx, home, ProjectScanLimits{Depth: 2, Limit: 10})
	if len(got) != 2 {
		t.Fatalf("found %+v", got)
	}
	if got[0].Path != filepath.Join(home, "code", "recent") || got[0].Name != "recent" {
		t.Errorf("first %+v", got[0])
	}
	if got[1].Path != filepath.Join(home, "old") {
		t.Errorf("second %+v", got[1])
	}
	if limited := ScanProjects(ctx, home, ProjectScanLimits{Depth: 2, Limit: 1}); len(limited) != 1 || limited[0].Name != "recent" {
		t.Errorf("limited %+v", limited)
	}
	if none := ScanProjects(ctx, "", ProjectScanLimits{Depth: 2, Limit: 10}); none == nil || len(none) != 0 {
		t.Errorf("empty home %+v", none)
	}
}

func scannedNames(found []ProjectCandidate) map[string]bool {
	names := map[string]bool{}
	for _, c := range found {
		names[c.Name] = true
	}
	return names
}

// #749: ~/Documents/Projects/<repo> is three levels deep, and the heavy folders around a project are not walked.
func TestScanProjectsDepthAndSkips(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	makeRepo(t, filepath.Join(home, "Documents", "Projects", "app"), now)
	makeRepo(t, filepath.Join(home, "Documents", "Projects", "Client", "site"), now)
	makeRepo(t, filepath.Join(home, "a", "b", "c", "d", "toodeep"), now)
	makeRepo(t, filepath.Join(home, "work", "vendor", "dep"), now)
	makeRepo(t, filepath.Join(home, "work", "target", "out"), now)
	makeRepo(t, filepath.Join(home, "AppData", "tool"), now)

	names := scannedNames(ScanProjects(context.Background(), home, ProjectScanLimits{Depth: 4, Limit: 10}))
	if !names["app"] || !names["site"] || len(names) != 2 {
		t.Errorf("found %v", names)
	}
}

// The walk is breadth first: a cut by the folder budget or the deadline keeps the shallow repositories.
func TestScanProjectsBounds(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	makeRepo(t, filepath.Join(home, "shallow"), now)
	makeRepo(t, filepath.Join(home, "x", "y", "deep"), now)

	names := scannedNames(ScanProjects(context.Background(), home, ProjectScanLimits{Depth: 4, Limit: 10, MaxDirs: 1}))
	if !names["shallow"] || names["deep"] {
		t.Errorf("budget of one folder found %v", names)
	}
	if all := scannedNames(ScanProjects(context.Background(), home, ProjectScanLimits{Depth: 4, Limit: 10})); !all["deep"] {
		t.Errorf("no budget found %v", all)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if done := ScanProjects(ctx, home, ProjectScanLimits{Depth: 4, Limit: 10}); done == nil || len(done) != 0 {
		t.Errorf("ended context found %+v", done)
	}
}
