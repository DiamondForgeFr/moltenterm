// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func tagNamed(snap *GitSnapshot, name string) *Tag {
	for i := range snap.Tags {
		if snap.Tags[i].Name == name {
			return &snap.Tags[i]
		}
	}
	return nil
}

// A candidate cut on another branch (a release worktree) leaves its notes in the tag only: the overview reads them
// from git.
func TestCollectGitReadsNotesFromTheTag(t *testing.T) {
	dir := makeGitFlowRepo(t)
	gitRun(t, dir, "checkout", "-q", "-b", "release-cut", "main")
	os.MkdirAll(filepath.Join(dir, "releases"), 0755)
	os.WriteFile(filepath.Join(dir, "releases", "v1.1.0-2.md"), []byte("Second candidate"), 0644)
	gitRun(t, dir, "add", "releases/v1.1.0-2.md")
	gitRun(t, dir, "commit", "-q", "-m", "chore(release): v1.1.0-2")
	gitRun(t, dir, "tag", "v1.1.0-2")
	gitRun(t, dir, "checkout", "-q", "develop")
	if _, err := os.Stat(filepath.Join(dir, "releases", "v1.1.0-2.md")); err == nil {
		t.Fatal("the checkout must not hold the candidate's notes")
	}
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	rc := tagNamed(snap, "v1.1.0-2")
	if rc == nil || rc.Notes != "Second candidate" || rc.NotesInternal != "" {
		t.Fatalf("candidate notes from the tag: %+v", rc)
	}
	if public := tagNamed(snap, "v1.0.0"); public == nil || public.Notes != "First release" {
		t.Fatalf("the checkout's notes still come first: %+v", public)
	}
}

func waitSnapshot(t *testing.T, published chan Snapshot) Snapshot {
	t.Helper()
	select {
	case snap := <-published:
		return snap
	case <-time.After(20 * time.Second):
		t.Fatal("no snapshot published")
	}
	return Snapshot{}
}

// A run that tagged the repository invalidates the project: the new tag shows without waiting for the cache to expire.
func TestCollectorInvalidateReadsTheNewTag(t *testing.T) {
	dir := makeGitFlowRepo(t)
	published := make(chan Snapshot, 4)
	c := MakeCollector(t.TempDir(), plainRunner, func(s Snapshot) { published <- s })
	c.Get(dir, time.Hour, false)
	waitSnapshot(t, published)
	gitRun(t, dir, "tag", "v1.1.0-2")
	cached, _ := c.Get(dir, time.Hour, false)
	if cached.Refreshing || tagNamed(cached.Git, "v1.1.0-2") != nil {
		t.Fatalf("within the hour the cache answers: %+v", cached.Git.Tags)
	}
	c.Invalidate(dir)
	fresh := waitSnapshot(t, published)
	if tagNamed(fresh.Git, "v1.1.0-2") == nil {
		t.Fatalf("after Invalidate the tag shows: %+v", fresh.Git.Tags)
	}
}

// An invalidation during a refresh is not lost: that refresh may have read git before the change, so another follows.
func TestCollectorInvalidateDuringARefresh(t *testing.T) {
	dir := makeGitFlowRepo(t)
	hold := make(chan struct{})
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			<-hold
			return nil, &MissingProgramError{Name: "gh"}
		}
		return plainRunner(ctx, d, name, args...)
	}
	published := make(chan Snapshot, 4)
	c := MakeCollector(t.TempDir(), run, func(s Snapshot) { published <- s })
	first, _ := c.Get(dir, time.Hour, false)
	if !first.Refreshing {
		t.Fatal("the first read refreshes")
	}
	gitRun(t, dir, "tag", "v1.1.0-2")
	c.Invalidate(dir)
	close(hold)
	waitSnapshot(t, published)
	second := waitSnapshot(t, published)
	if tagNamed(second.Git, "v1.1.0-2") == nil {
		t.Fatalf("the refresh after the invalidation reads the tag: %+v", second.Git.Tags)
	}
	if invalidate, start := c.takeAgain(dir); start || invalidate.git {
		t.Fatal("one invalidation runs one more refresh")
	}
}

func TestCollectorInvalidateIgnoresARelativeFolder(t *testing.T) {
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	c.Invalidate("relative/path")
	if len(c.projects) != 0 {
		t.Fatalf("a relative folder is not a project: %+v", c.projects)
	}
}
