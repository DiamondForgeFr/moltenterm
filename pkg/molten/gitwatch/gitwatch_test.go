// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package gitwatch

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const changeWait = time.Second

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func makeRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(dir, "repo")
	os.MkdirAll(repo, 0755)
	gitIn(t, repo, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a\n"), 0644)
	gitIn(t, repo, "add", "a.txt")
	gitIn(t, repo, "commit", "-q", "-m", "first")
	return repo
}

type changes struct {
	lock  sync.Mutex
	roots []string
	got   chan string
}

func listen(w *Watcher) *changes {
	c := &changes{got: make(chan string, 64)}
	w.OnChange(func(root string) {
		c.lock.Lock()
		c.roots = append(c.roots, root)
		c.lock.Unlock()
		c.got <- root
	})
	return c
}

func (c *changes) wait(t *testing.T, root string) time.Duration {
	t.Helper()
	start := time.Now()
	deadline := time.After(changeWait)
	for {
		select {
		case r := <-c.got:
			if r == root {
				return time.Since(start)
			}
		case <-deadline:
			t.Fatalf("no change seen for %s within %s", root, changeWait)
		}
	}
}

func (c *changes) none(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case r := <-c.got:
		t.Fatalf("unexpected change for %s", r)
	case <-time.After(d):
	}
}

func TestReadDirsMainAndWorktree(t *testing.T) {
	repo := makeRepo(t)
	dirs, err := ReadDirs(repo)
	if err != nil {
		t.Fatal(err)
	}
	if dirs.GitDir != filepath.Join(repo, ".git") || dirs.Linked() {
		t.Fatalf("main checkout: %+v", dirs)
	}
	wt := filepath.Join(filepath.Dir(repo), "wt")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feature/x", wt)
	dirs, err = ReadDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	if !dirs.Linked() || dirs.CommonDir != filepath.Join(repo, ".git") || !strings.HasPrefix(dirs.GitDir, filepath.Join(repo, ".git", "worktrees")) {
		t.Fatalf("worktree: %+v", dirs)
	}
	if got := HeadBranch(dirs.GitDir); got != "feature/x" {
		t.Fatalf("worktree branch %q", got)
	}
	if _, err := ReadDirs(filepath.Dir(repo)); err == nil {
		t.Fatalf("a folder without .git has no git folders")
	}
}

func TestWatcherSeesCommitCheckoutAndStaging(t *testing.T) {
	repo := makeRepo(t)
	w := MakeWatcher(20 * time.Millisecond)
	defer w.Close()
	c := listen(w)
	seq, ok := w.Track(repo)
	if !ok {
		t.Fatal("not watched")
	}
	// A status that takes no lock writes nothing: no change.
	gitIn(t, repo, "--no-optional-locks", "status", "--porcelain=v2", "--branch")
	c.none(t, 200*time.Millisecond)
	if next, _ := w.Seq(repo); next != seq {
		t.Fatalf("status moved the sequence %d -> %d", seq, next)
	}

	os.WriteFile(filepath.Join(repo, "b.txt"), []byte("b\n"), 0644)
	gitIn(t, repo, "add", "b.txt")
	c.wait(t, repo)
	gitIn(t, repo, "commit", "-q", "-m", "second")
	c.wait(t, repo)
	gitIn(t, repo, "checkout", "-q", "-b", "feature/slash")
	c.wait(t, repo)
	// A commit on a branch whose ref lives in a folder created after the watch started.
	os.WriteFile(filepath.Join(repo, "c.txt"), []byte("c\n"), 0644)
	gitIn(t, repo, "add", "c.txt")
	c.wait(t, repo)
	gitIn(t, repo, "commit", "-q", "-m", "third")
	c.wait(t, repo)
	if next, _ := w.Seq(repo); next == seq {
		t.Fatalf("sequence did not move")
	}
}

func TestWatcherSeesBranchMoveWithoutIndexChange(t *testing.T) {
	repo := makeRepo(t)
	gitIn(t, repo, "branch", "other")
	w := MakeWatcher(20 * time.Millisecond)
	defer w.Close()
	c := listen(w)
	if _, ok := w.Track(repo); !ok {
		t.Fatal("not watched")
	}
	// update-ref touches only refs/heads/other.
	head := gitIn(t, repo, "rev-parse", "HEAD")
	gitIn(t, repo, "commit-tree", "-m", "x", "-p", head, head+"^{tree}")
	gitIn(t, repo, "update-ref", "refs/heads/other", gitIn(t, repo, "commit-tree", "-m", "y", "-p", head, head+"^{tree}"))
	c.wait(t, repo)
}

func TestWatcherWorktreeSeesItsOwnHead(t *testing.T) {
	repo := makeRepo(t)
	wt := filepath.Join(filepath.Dir(repo), "wt")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "wt-branch", wt)
	w := MakeWatcher(20 * time.Millisecond)
	defer w.Close()
	c := listen(w)
	if _, ok := w.Track(wt); !ok {
		t.Fatal("worktree not watched")
	}
	gitIn(t, wt, "checkout", "-q", "-b", "wt-other")
	c.wait(t, wt)
	os.WriteFile(filepath.Join(wt, "d.txt"), []byte("d\n"), 0644)
	gitIn(t, wt, "add", "d.txt")
	gitIn(t, wt, "commit", "-q", "-m", "in worktree")
	c.wait(t, wt)
}

func TestWatcherNotARepository(t *testing.T) {
	w := MakeWatcher(20 * time.Millisecond)
	defer w.Close()
	if _, ok := w.Track(t.TempDir()); ok {
		t.Fatal("a plain folder is not watched")
	}
	if w.Trees() != 0 {
		t.Fatal("nothing should be tracked")
	}
}

func TestWatcherBoundedAndIdleDrop(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	w := MakeWatcher(20 * time.Millisecond)
	defer w.Close()
	now := time.Now()
	w.now = func() time.Time { return now }
	var roots []string
	for i := 0; i < MaxTrees+5; i++ {
		root := filepath.Join(base, fmt.Sprintf("r%02d", i))
		os.MkdirAll(filepath.Join(root, ".git", "refs", "heads"), 0755)
		os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0644)
		roots = append(roots, root)
		now = now.Add(time.Second)
		if _, ok := w.Track(root); !ok {
			t.Fatalf("%s not watched", root)
		}
	}
	if w.Trees() != MaxTrees {
		t.Fatalf("watched %d trees, want %d", w.Trees(), MaxTrees)
	}
	if _, ok := w.Seq(roots[0]); ok {
		t.Fatal("the least recently asked tree should have been dropped")
	}
	if _, ok := w.Seq(roots[len(roots)-1]); !ok {
		t.Fatal("the last tree should be watched")
	}
	now = now.Add(IdleDrop + time.Second)
	extra := filepath.Join(base, "extra")
	os.MkdirAll(filepath.Join(extra, ".git"), 0755)
	w.Track(extra)
	if w.Trees() != 1 {
		t.Fatalf("idle trees not dropped: %d watched", w.Trees())
	}
	w.lock.Lock()
	dirs := len(w.dirTrees)
	w.lock.Unlock()
	if dirs != 1 {
		t.Fatalf("watched folders not released: %d", dirs)
	}
}
