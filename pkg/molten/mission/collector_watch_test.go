// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/gitwatch"
)

// FR-PERF-011 (audit B3, B11): the collector holds a bounded set of projects and reads git and GitHub only for a
// Mission Control view, or after a change.

func TestCollectorProjectsBounded(t *testing.T) {
	base := t.TempDir()
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	var dirs []string
	for i := 0; i < 1000; i++ {
		dir := filepath.Join(base, fmt.Sprintf("p%04d", i))
		os.MkdirAll(dir, 0755)
		dirs = append(dirs, dir)
		c.lock.Lock()
		c.stateLocked(dir)
		c.lock.Unlock()
		now = now.Add(time.Millisecond)
	}
	if c.Size() > maxProjects {
		t.Fatalf("%d projects held", c.Size())
	}
	c.lock.Lock()
	_, newest := c.projects[dirs[len(dirs)-1]]
	_, oldest := c.projects[dirs[0]]
	c.lock.Unlock()
	if !newest || oldest {
		t.Fatal("the least recently asked projects should go first")
	}
}

func TestCollectorEvictsGoneFoldersFirst(t *testing.T) {
	base := t.TempDir()
	c := MakeCollector(t.TempDir(), plainRunner, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	gone := map[string]bool{}
	for i := 0; i < maxProjects; i++ {
		dir := filepath.Join(base, fmt.Sprintf("p%02d", i))
		c.lock.Lock()
		c.stateLocked(dir)
		c.lock.Unlock()
		if i%2 == 0 {
			gone[dir] = true
		}
		now = now.Add(time.Millisecond)
	}
	c.exists = func(dir string) bool { return !gone[dir] }
	c.lock.Lock()
	c.stateLocked(filepath.Join(base, "new"))
	left := len(c.projects)
	c.lock.Unlock()
	if left != maxProjects/2+1 {
		t.Fatalf("%d projects left, want the %d live ones and the new one", left, maxProjects/2)
	}
	// A request for a folder that is gone answers Missing and keeps nothing.
	missing := filepath.Join(base, "missing")
	c.exists = dirExists
	snap, _ := c.Get(missing, time.Minute, false)
	c.lock.Lock()
	_, kept := c.projects[missing]
	c.lock.Unlock()
	if !snap.Missing || kept {
		t.Fatalf("missing folder: %+v, kept %v", snap, kept)
	}
}

func TestStartRefreshPassiveAndWatched(t *testing.T) {
	c := MakeCollector("", plainRunner, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	read := func(gitAge time.Duration, githubAge time.Duration) *projectState {
		return &projectState{
			snap:       Snapshot{GitAt: now.Add(-gitAge).UnixMilli(), GithubAt: now.Add(-githubAge).UnixMilli()},
			gitSeq:     7,
			gitWatched: true,
			fetchedAt:  now.Add(-gitAge),
		}
	}
	cases := []struct {
		name   string
		state  *projectState
		ask    refreshAsk
		start  bool
		git    bool
		github bool
		fetch  bool
	}{
		{"view, watched, nothing changed", read(2*time.Minute, 30*time.Second), refreshAsk{maxAge: time.Minute, seq: 7, watched: true}, false, false, false, false},
		{"view, watched, changed", read(10*time.Second, 30*time.Second), refreshAsk{maxAge: time.Minute, seq: 8, watched: true}, true, true, false, false},
		{"view, watched, fetch due", read(6*time.Minute, 30*time.Second), refreshAsk{maxAge: time.Minute, seq: 7, watched: true}, true, true, false, true},
		{"view, not watched, old", read(2*time.Minute, 30*time.Second), refreshAsk{maxAge: time.Minute}, true, true, false, false},
		{"view, GitHub a minute old", read(10*time.Second, 2*time.Minute), refreshAsk{maxAge: time.Minute, seq: 7, watched: true}, true, false, true, false},
		{"passive, watched, nothing changed", read(time.Hour, 5*time.Minute), refreshAsk{maxAge: time.Minute, passive: true, seq: 7, watched: true}, false, false, false, false},
		{"passive, watched, changed", read(time.Hour, 5*time.Minute), refreshAsk{maxAge: time.Minute, passive: true, seq: 9, watched: true}, true, true, false, false},
		{"passive, GitHub due", read(time.Second, 11*time.Minute), refreshAsk{maxAge: time.Minute, passive: true, seq: 7, watched: true}, true, false, true, false},
		{"passive forced is not forced", read(time.Second, 2*time.Minute), refreshAsk{forced: true, passive: true, seq: 7, watched: true}, false, false, false, false},
		{"passive, not watched, old", read(6*time.Minute, 5*time.Minute), refreshAsk{maxAge: time.Minute, passive: true}, true, true, false, false},
	}
	for _, tc := range cases {
		plan, start := c.startRefreshLocked(tc.state, tc.ask)
		if start != tc.start || plan.git != tc.git || plan.github != tc.github || plan.fetch != tc.fetch {
			t.Errorf("%s: start %v plan %+v", tc.name, start, plan)
		}
	}
}

// #688: the rail's Reviews counts read GitHub every railGithubInterval, and never call gh for a project without a
// GitHub origin or once gh was missing or signed out.
func TestStartRefreshRailReviews(t *testing.T) {
	c := MakeCollector("", plainRunner, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	read := func(githubAge time.Duration, remote string, ghState string) *projectState {
		state := &projectState{
			snap: Snapshot{
				GitAt:    now.Add(-time.Second).UnixMilli(),
				GithubAt: now.Add(-githubAge).UnixMilli(),
				Git:      &GitSnapshot{RemoteUrl: remote},
			},
			gitSeq:     7,
			gitWatched: true,
			fetchedAt:  now,
		}
		if ghState != "" {
			state.snap.Github = &GithubSnapshot{State: ghState}
		}
		return state
	}
	const origin = "https://github.com/acme/app"
	rail := refreshAsk{maxAge: time.Minute, passive: true, githubEvery: railGithubInterval, seq: 7, watched: true}
	cases := []struct {
		name   string
		state  *projectState
		github bool
	}{
		{"GitHub due", read(3*time.Minute, origin, GithubStateOk), true},
		{"GitHub never read", read(time.Hour, origin, ""), true},
		{"GitHub fresh (a view keeps it)", read(30*time.Second, origin, GithubStateOk), false},
		{"GitHub a minute old", read(90*time.Second, origin, GithubStateOk), false},
		{"no GitHub origin", read(time.Hour, "", ""), false},
		{"gh missing", read(time.Hour, origin, GithubStateNoGh), false},
		{"gh signed out", read(time.Hour, origin, GithubStateLoggedOut), false},
		{"not a GitHub repository", read(time.Hour, origin, GithubStateNoRepo), false},
		{"last read failed", read(3*time.Minute, origin, GithubStateError), true},
	}
	for _, tc := range cases {
		plan, start := c.startRefreshLocked(tc.state, rail)
		if plan.github != tc.github || start != tc.github || plan.fetch {
			t.Errorf("%s: start %v plan %+v", tc.name, start, plan)
		}
	}
	noGit := &projectState{snap: Snapshot{GithubAt: 0}}
	plan, start := c.startRefreshLocked(noGit, refreshAsk{maxAge: time.Minute, passive: true, githubEvery: railGithubInterval})
	if !start || !plan.git || plan.github || plan.fetch {
		t.Errorf("unknown project: git first, no gh: start %v plan %+v", start, plan)
	}
}

func TestCollectorRereadsOnChangeOnlyForAView(t *testing.T) {
	dir := makeGitFlowRepo(t)
	var gitReads atomic.Int32
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return nil, &MissingProgramError{Name: "gh"}
		}
		if len(args) > 0 && args[0] == "rev-parse" && len(args) > 1 && args[1] == "--git-dir" {
			gitReads.Add(1)
		}
		return plainRunner(ctx, d, name, args...)
	}
	published := make(chan Snapshot, 16)
	c := MakeCollector(t.TempDir(), run, func(s Snapshot) { published <- s })
	watch := gitwatch.MakeWatcher(10 * time.Millisecond)
	defer watch.Close()
	c.UseWatcher(watch)
	changed := make(chan string, 16)
	watch.OnChange(func(root string) {
		c.RepoChanged(root)
		changed <- root
	})
	// Generous timeouts: they only bound a failing run, a passing one never waits for them (#621).
	wait := func(what string) Snapshot {
		t.Helper()
		select {
		case s := <-published:
			return s
		case <-time.After(30 * time.Second):
			t.Fatalf("no refresh: %s", what)
		}
		return Snapshot{}
	}
	// A loaded machine can split one git command's writes into several watch events, each re-read for a view: the
	// snapshots before the one on branch are not failures.
	waitBranch := func(what string, branch string) Snapshot {
		t.Helper()
		for {
			if s := wait(what); s.Git != nil && s.Git.Current == branch {
				return s
			}
		}
	}
	refreshing := func() bool {
		c.lock.Lock()
		defer c.lock.Unlock()
		state := c.projects[dir]
		return state != nil && state.refreshing
	}
	c.Warm(dir)
	wait("first passive read")
	if gitReads.Load() != 1 {
		t.Fatalf("first read: %d", gitReads.Load())
	}
	// Passive only: a change waits for the next request. The watch calls RepoChanged before it signals changed, so
	// a refresh it would start is already marked; no sleep has to guess how long the scheduler takes.
	gitRun(t, dir, "checkout", "-q", "-b", "feature/9-new")
	select {
	case <-changed:
	case <-time.After(30 * time.Second):
		t.Fatal("the watch saw no change")
	}
	if refreshing() || gitReads.Load() != 1 {
		t.Fatalf("a change re-read a project no view looks at: %d reads, refreshing %v", gitReads.Load(), refreshing())
	}
	c.Warm(dir)
	waitBranch("passive read after a change", "feature/9-new")
	if gitReads.Load() < 2 {
		t.Fatalf("passive after change: %d reads", gitReads.Load())
	}
	// A view asked: the next change is read with no further request, the only way a snapshot on develop can come.
	if s, _ := c.Get(dir, time.Minute, false); s.Refreshing {
		wait("view request")
	}
	before := gitReads.Load()
	gitRun(t, dir, "checkout", "-q", "develop")
	waitBranch("view after a change", "develop")
	if gitReads.Load() <= before {
		t.Fatalf("view after change: %d reads", gitReads.Load()-before)
	}
}

// AC3: repeated refreshes over many projects keep the collector's memory flat.
func TestCollectorMemoryFlatOverRefreshes(t *testing.T) {
	base := t.TempDir()
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		return nil, &MissingProgramError{Name: name}
	}
	done := make(chan struct{}, 1024)
	c := MakeCollector("", run, func(Snapshot) { done <- struct{}{} })
	cycle := func(round int) {
		for i := 0; i < 200; i++ {
			dir := filepath.Join(base, fmt.Sprintf("r%d-%03d", round%3, i))
			os.MkdirAll(dir, 0755)
			if _, err := c.Get(dir, 0, false); err == nil {
				<-done
			}
		}
	}
	heap := func() uint64 {
		runtime.GC()
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return m.HeapAlloc
	}
	cycle(0)
	start := heap()
	for round := 1; round <= 10; round++ {
		cycle(round)
	}
	end := heap()
	if c.Size() > maxProjects {
		t.Fatalf("%d projects held", c.Size())
	}
	if end > start+2*1024*1024 {
		t.Fatalf("heap grew from %d to %d bytes over 2000 refreshes", start, end)
	}
}
