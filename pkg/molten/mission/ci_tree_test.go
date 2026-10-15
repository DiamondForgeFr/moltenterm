// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pruneWorktreeMetadata removes the project's .git/worktrees/<name> entry a linked worktree points at, leaving its
// folder and .git file behind.
func pruneWorktreeMetadata(t *testing.T, tree string) {
	t.Helper()
	link, err := os.ReadFile(filepath.Join(tree, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	gitdir := strings.TrimSpace(strings.TrimPrefix(string(link), "gitdir:"))
	if !strings.Contains(gitdir, filepath.Join(".git", "worktrees")) {
		t.Fatalf("not a linked worktree: %s", gitdir)
	}
	if err := os.RemoveAll(gitdir); err != nil {
		t.Fatal(err)
	}
}

func TestCiTreeRecoversFromPrunedMetadata(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"check","run":"test -f a.txt"}]}`)
	if first := startCi(t, c, dir, CiRunRequest{}); first.Status != CiStateSuccess {
		t.Fatalf("first run: %+v", first)
	}
	pruneWorktreeMetadata(t, c.worktreeDir(dir))
	second := startCi(t, c, dir, CiRunRequest{Force: true})
	if second.Status != CiStateSuccess {
		prepare, _ := c.ReadLog(dir, second.Id, "prepare", 0)
		t.Fatalf("a CI tree whose metadata was pruned must be recreated: %+v\n%s", second, prepare.Text)
	}
}
