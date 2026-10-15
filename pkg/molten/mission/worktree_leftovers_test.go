// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #716: git worktree remove can end in "Directory not empty" after unregistering the worktree, when something writes
// into the folder during the removal. The runner below does the real removal, then writes that file and fails as git
// does; refuse fails without removing anything (a real failure).
func leftoverRunner(t *testing.T, refuse error) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		removing := false
		for i := 0; i+1 < len(args); i++ {
			removing = removing || (args[i] == "worktree" && args[i+1] == "remove")
		}
		if !removing {
			return plainRunner(ctx, dir, name, args...)
		}
		if refuse != nil {
			return nil, refuse
		}
		out, err := plainRunner(ctx, dir, name, args...)
		if err != nil {
			return out, err
		}
		path := args[len(args)-1]
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Error(err)
		}
		if err := os.WriteFile(filepath.Join(path, ".DS_Store"), []byte("metadata"), 0644); err != nil {
			t.Error(err)
		}
		return out, fmt.Errorf("error: failed to delete '%s': Directory not empty", path)
	}
}

type leftoverHooks struct {
	removals int
	waits    int
	remove   func(path string) error
}

func (h *leftoverHooks) install(w *Worktrees) {
	w.SetLeftoverHooks(func(path string) error {
		h.removals++
		if h.remove != nil {
			return h.remove(path)
		}
		return os.RemoveAll(path)
	}, func(ctx context.Context, d time.Duration) bool {
		h.waits++
		return true
	})
}

func TestWorktreeRemovalLeftoversAreRemoved(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(leftoverRunner(t, nil), noTerminals)
	hooks := &leftoverHooks{}
	// A file is written again while the first try deletes; the second try ends the job.
	hooks.remove = func(path string) error {
		os.RemoveAll(path)
		if hooks.removals == 1 {
			os.MkdirAll(path, 0755)
			os.WriteFile(filepath.Join(path, ".DS_Store"), []byte("again"), 0644)
			return errors.New("directory not empty")
		}
		return nil
	}
	hooks.install(w)

	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree, DeleteBranch: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Removed || !res.LeftoversRemoved || res.Leftover != "" || res.BranchDeleted != "feature/5-x" {
		t.Fatalf("result: %+v", res)
	}
	if _, err := os.Lstat(tree); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the leftovers stay: %v", err)
	}
	if hooks.removals != 2 || hooks.waits != 1 {
		t.Fatalf("tries: %d removals, %d waits", hooks.removals, hooks.waits)
	}
	if _, err := os.Stat(filepath.Join(clone, "a.txt")); err != nil {
		t.Fatal("the main checkout lost a file")
	}
}

func TestWorktreeRemovalLeftoverStaysAsAWarning(t *testing.T) {
	_, _, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(leftoverRunner(t, nil), noTerminals)
	hooks := &leftoverHooks{remove: func(path string) error { return errors.New("directory not empty") }}
	hooks.install(w)

	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree, DeleteBranch: true})
	if err != nil {
		t.Fatalf("a worktree git unregistered failed: %v", err)
	}
	if !res.Removed || res.Leftover != tree || !strings.Contains(res.LeftoverError, "not empty") || res.BranchDeleted != "feature/5-x" {
		t.Fatalf("result: %+v", res)
	}
	if hooks.removals != 3 || hooks.waits != 2 {
		t.Fatalf("tries: %d removals, %d waits", hooks.removals, hooks.waits)
	}
}

func TestWorktreeRemovalGitRefusesStillFails(t *testing.T) {
	_, _, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(leftoverRunner(t, errors.New("fatal: boom")), noTerminals)
	hooks := &leftoverHooks{}
	hooks.install(w)

	if _, err := w.Remove(WorktreeRemoveRequest{Dir: tree, DeleteBranch: true}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error: %v", err)
	}
	if hooks.removals != 0 {
		t.Fatalf("a worktree git still lists was removed by hand")
	}
	if _, err := os.Stat(filepath.Join(tree, ".git")); err != nil {
		t.Fatal("the worktree was touched")
	}
}

func TestRemoveLeftoverRefuses(t *testing.T) {
	base, clone, tree := makeWorktreeFixture(t)
	w := MakeWorktrees(plainRunner, noTerminals)
	hooks := &leftoverHooks{}
	hooks.install(w)
	ctx := context.Background()
	w.home = filepath.Join(base, "home")
	os.MkdirAll(filepath.Join(w.home, "x"), 0755)
	for name, path := range map[string]string{
		"a worktree git lists":  tree,
		"the main checkout":     clone,
		"a parent of the clone": base,
		"the home folder":       w.home,
		"a relative path":       "wt",
	} {
		if _, err := w.RemoveLeftover(ctx, clone, path); err == nil {
			t.Errorf("%s: removed", name)
		}
	}
	// A folder holding a repository of its own.
	repo := filepath.Join(base, "other")
	os.MkdirAll(filepath.Join(repo, ".git"), 0755)
	if _, err := w.RemoveLeftover(ctx, clone, repo); err == nil {
		t.Errorf("a repository: removed")
	}
	if hooks.removals != 0 {
		t.Fatalf("%d removals", hooks.removals)
	}
}
