// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
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

	got := ScanProjects(home, 2, 10)
	if len(got) != 2 {
		t.Fatalf("found %+v", got)
	}
	if got[0].Path != filepath.Join(home, "code", "recent") || got[0].Name != "recent" {
		t.Errorf("first %+v", got[0])
	}
	if got[1].Path != filepath.Join(home, "old") {
		t.Errorf("second %+v", got[1])
	}
	if limited := ScanProjects(home, 2, 1); len(limited) != 1 || limited[0].Name != "recent" {
		t.Errorf("limited %+v", limited)
	}
	if none := ScanProjects("", 2, 10); none == nil || len(none) != 0 {
		t.Errorf("empty home %+v", none)
	}
}
