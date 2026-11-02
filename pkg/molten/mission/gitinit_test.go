// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
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

// The GitHub read made before git init failed on "not a git repository"; the one after must ask again (#1650), not
// keep that answer for minGithubInterval.
func TestInitGitReadsGithubAgain(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	var ghCalls atomic.Int64
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name != "gh" {
			return plainRunner(ctx, d, name, args...)
		}
		ghCalls.Add(1)
		if _, err := os.Stat(filepath.Join(d, ".git")); err != nil {
			return nil, errors.New("failed to run git: fatal: not a git repository (or any of the parent directories): .git")
		}
		return nil, errors.New("no git remotes found")
	}
	published := make(chan Snapshot, 8)
	c := MakeCollector(t.TempDir(), run, func(s Snapshot) { published <- s })
	next := func(what string) Snapshot {
		select {
		case s := <-published:
			return s
		case <-time.After(time.Minute):
			t.Fatalf("no snapshot %s", what)
			return Snapshot{}
		}
	}
	if _, err := c.Get(dir, 0, true); err != nil {
		t.Fatalf("first read: %v", err)
	}
	if before := next("before git init"); before.Github == nil || before.Github.State != GithubStateError {
		t.Fatalf("before git init the GitHub state is %+v, want error", before.Github)
	}
	if _, err := c.InitGit(GitInitRequest{Dir: dir}); err != nil {
		t.Fatalf("git init: %v", err)
	}
	if after := next("after git init"); after.Github == nil || after.Github.State != GithubStateNoRepo {
		t.Fatalf("after git init the GitHub state is %+v, want norepo", after.Github)
	}
	if ghCalls.Load() != 2 {
		t.Fatalf("gh was asked %d times, want a second read after git init", ghCalls.Load())
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
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{collector: MakeCollector(t.TempDir(), plainRunner, nil)}).route())
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	routetest.MustRefuseWith(t, link, e.NonWindows(), GitInitCommand, map[string]any{"dir": dir}, "from a MoltenTerm window")
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Fatalf("a caller other than a window initialized a repository")
	}
}
