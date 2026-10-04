// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParseGitDirs(t *testing.T) {
	gitDir, common, linked := ParseGitDirs("/r/.git/worktrees/wt\n/r/.git\n")
	if !linked || gitDir != "/r/.git/worktrees/wt" || common != "/r/.git" {
		t.Fatalf("worktree: %q %q %v", gitDir, common, linked)
	}
	if _, _, linked := ParseGitDirs("/r/.git/modules/lib\n/r/.git/modules/lib\n"); linked {
		t.Fatal("a submodule read as a worktree")
	}
	if _, _, linked := ParseGitDirs("relative\n/r/.git\n"); linked {
		t.Fatal("a relative answer was trusted")
	}
	if MainCheckoutOf("/r/.git") != "/r" || MainCheckoutOf("/srv/repo.git") != "/srv/repo.git" {
		t.Fatal("main checkout")
	}
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestResolveWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	os.MkdirAll(repo, 0755)
	gitIn(t, repo, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a"), 0644)
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "a")
	tree := filepath.Join(base, "wt")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feature/1-x", tree)
	sub := filepath.Join(tree, "src")
	os.MkdirAll(sub, 0755)
	info, err := ResolveWorktree(sub)
	if err != nil {
		t.Fatal(err)
	}
	main, _ := filepath.EvalSymlinks(repo)
	got, _ := filepath.EvalSymlinks(info.Main)
	if info.Path != tree || got != main || info.Branch != "feature/1-x" {
		t.Fatalf("worktree: %+v", info)
	}
	if _, err := ResolveWorktree(repo); err == nil {
		t.Fatal("the main tree was linked as a worktree")
	}
	if _, err := ResolveWorktree(base); err == nil {
		t.Fatal("a folder outside git was linked")
	}
	if !WorktreeMissing(filepath.Join(base, "gone")) || WorktreeMissing(tree) {
		t.Fatal("missing")
	}
}
