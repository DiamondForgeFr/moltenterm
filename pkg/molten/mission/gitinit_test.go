// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitGitCreatesARepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	snap, err := c.InitGit(GitInitRequest{Dir: dir})
	if err != nil {
		t.Fatalf("git init: %v", err)
	}
	if snap.Dir != dir {
		t.Fatalf("the snapshot is for %q, not %q", snap.Dir, dir)
	}
	if info, err := os.Stat(filepath.Join(dir, ".git")); err != nil || !info.IsDir() {
		t.Fatalf("no .git folder after git init")
	}
}

func TestInitGitRefusesARepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "--quiet", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	inner := filepath.Join(dir, "sub")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	for _, d := range []string{dir, inner} {
		if _, err := c.InitGit(GitInitRequest{Dir: d}); err == nil || !strings.Contains(err.Error(), "already inside") {
			t.Fatalf("%s: want a refusal, got %v", d, err)
		}
	}
	if _, err := os.Stat(filepath.Join(inner, ".git")); err == nil {
		t.Fatalf("a nested repository was created")
	}
}

func TestInitGitRefusesAMissingOrRelativeFolder(t *testing.T) {
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	if _, err := c.InitGit(GitInitRequest{Dir: "relative/path"}); err == nil {
		t.Fatalf("a relative path was accepted")
	}
	if _, err := c.InitGit(GitInitRequest{Dir: filepath.Join(t.TempDir(), "gone")}); err == nil {
		t.Fatalf("a missing folder was accepted")
	}
}

func TestInitGitOnlyFromAWindow(t *testing.T) {
	l := &routeLink{collector: MakeCollector(t.TempDir(), plainRunner, nil)}
	if _, err := l.handle(GitInitCommand, "proc:term", map[string]any{"dir": t.TempDir()}); err == nil {
		t.Fatalf("a terminal could initialize git")
	}
}
