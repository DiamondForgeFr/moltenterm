// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/gitwatch"
)

// FR-PERF-011: a watched tree costs one git status per change, however many panes ask and however often.

type gitCounter struct {
	byArg sync.Map
	total atomic.Int32
}

func (c *gitCounter) runner(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	c.total.Add(1)
	for _, arg := range args {
		switch arg {
		case "status", "rev-list", "remote", "rev-parse", "symbolic-ref":
			n, _ := c.byArg.LoadOrStore(arg, new(atomic.Int32))
			n.(*atomic.Int32).Add(1)
		}
	}
	return plainRunner(ctx, dir, name, args...)
}

func (c *gitCounter) count(arg string) int32 {
	n, ok := c.byArg.Load(arg)
	if !ok {
		return 0
	}
	return n.(*atomic.Int32).Load()
}

type watchedPanes struct {
	panes   *Panes
	watch   *gitwatch.Watcher
	changed chan string
	lock    sync.Mutex
	clock   time.Time
}

func makeWatchedPanes(t *testing.T, run Runner) *watchedPanes {
	t.Helper()
	w := &watchedPanes{watch: gitwatch.MakeWatcher(10 * time.Millisecond), changed: make(chan string, 64), clock: time.Now()}
	t.Cleanup(w.watch.Close)
	w.watch.OnChange(func(root string) { w.changed <- root })
	w.panes = MakePanes(run, nil, nil)
	w.panes.UseWatcher(w.watch)
	w.panes.now = w.now
	w.panes.sleep = w.advance
	return w
}

func (w *watchedPanes) now() time.Time {
	w.lock.Lock()
	defer w.lock.Unlock()
	return w.clock
}

func (w *watchedPanes) advance(d time.Duration) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.clock = w.clock.Add(d)
}

func (w *watchedPanes) waitChange(t *testing.T, root string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case r := <-w.changed:
			if r == root {
				return
			}
		case <-deadline:
			t.Fatalf("the watch did not see %s change", root)
		}
	}
}

func TestPaneWatchedTreeProbesOncePerChange(t *testing.T) {
	_, clone := makePaneRepo(t)
	var git gitCounter
	w := makeWatchedPanes(t, git.runner)
	first, _ := w.panes.Get(PaneRequest{Dir: clone})
	if first.Branch != "develop" || git.count("status") != 1 {
		t.Fatalf("first answer %+v, %d probes", first, git.count("status"))
	}
	// Panes polling every 3 s for 50 s, several on the same tree at once: no git while nothing changed.
	for i := 0; i < 16; i++ {
		w.advance(3 * time.Second)
		var wg sync.WaitGroup
		for j := 0; j < 4; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				w.panes.Get(PaneRequest{Dir: filepath.Join(clone, ".")})
			}()
		}
		wg.Wait()
	}
	if git.count("status") != 1 {
		t.Fatalf("an unchanged tree was probed %d times", git.count("status"))
	}
	commit(t, clone, "b.txt", "feat(#2): second")
	w.waitChange(t, clone)
	var wg sync.WaitGroup
	for j := 0; j < 4; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.panes.Get(PaneRequest{Dir: clone})
		}()
	}
	wg.Wait()
	after, _ := w.panes.Get(PaneRequest{Dir: clone})
	if git.count("status") != 2 || after.Ahead != 1 || after.Sha == first.Sha {
		t.Fatalf("after a commit: %d probes, %+v", git.count("status"), after)
	}
	// A file edited outside a terminal changes no git file: it shows within paneWatchedMaxAge.
	os.WriteFile(filepath.Join(clone, "edited.txt"), []byte("x"), 0644)
	w.advance(paneWatchedMaxAge / 2)
	if state, _ := w.panes.Get(PaneRequest{Dir: clone}); state.Dirty {
		t.Fatal("probed before the edit could be known")
	}
	w.advance(paneWatchedMaxAge)
	if state, _ := w.panes.Get(PaneRequest{Dir: clone}); !state.Dirty || git.count("status") != 3 {
		t.Fatalf("the edit after the watched max age: %+v, %d probes", state, git.count("status"))
	}
	// A prompt back still probes.
	w.advance(2 * time.Second)
	w.panes.Get(PaneRequest{Dir: clone, Fresh: true})
	if git.count("status") != 4 {
		t.Fatalf("a fresh request did not probe: %d", git.count("status"))
	}
}

func TestPaneUnpushedCountedOnlyWhenRefsMove(t *testing.T) {
	_, clone := makePaneRepo(t)
	gitRun(t, clone, "checkout", "-q", "-b", "feature/3-local")
	commit(t, clone, "l.txt", "feat(#3): local")
	var git gitCounter
	w := makeWatchedPanes(t, git.runner)
	state, _ := w.panes.Get(PaneRequest{Dir: clone})
	if state.Upstream != "" || state.Ahead != 1 || git.count("rev-list") != 1 {
		t.Fatalf("first: %+v, rev-list %d", state, git.count("rev-list"))
	}
	w.advance(paneWatchedMaxAge + time.Second)
	state, _ = w.panes.Get(PaneRequest{Dir: clone})
	if state.Ahead != 1 || git.count("status") != 2 || git.count("rev-list") != 1 {
		t.Fatalf("same HEAD and refs: %+v, status %d, rev-list %d", state, git.count("status"), git.count("rev-list"))
	}
	commit(t, clone, "m.txt", "feat(#3): more")
	w.waitChange(t, clone)
	state, _ = w.panes.Get(PaneRequest{Dir: clone})
	if state.Ahead != 2 || git.count("rev-list") != 2 {
		t.Fatalf("after a commit: %+v, rev-list %d", state, git.count("rev-list"))
	}
}

func TestPaneWorktreeKindWithoutGit(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	var git gitCounter
	state, _ := MakePanes(git.runner, nil, nil).Get(PaneRequest{Dir: tree})
	resolved, _ := filepath.EvalSymlinks(clone)
	project, _ := filepath.EvalSymlinks(state.Project)
	if !state.Worktree || project != resolved || state.Branch != "feature/5-x" {
		t.Fatalf("worktree: %+v", state)
	}
	if git.count("rev-parse") != 0 {
		t.Fatalf("the worktree's git folders were asked to git: %d", git.count("rev-parse"))
	}
}

func TestPaneCiVerdictsForgottenOnCiChange(t *testing.T) {
	p := MakePanes(plainRunner, nil, nil)
	p.storeCi(paneCiKey{project: "/a", sha: "1"}, CiStateSuccess)
	p.storeCi(paneCiKey{project: "/b", sha: "1"}, CiStateFailure)
	p.CiChanged("/a")
	if _, ok := p.cachedCi(paneCiKey{project: "/a", sha: "1"}); ok {
		t.Fatal("the ended run's project kept its verdict")
	}
	if v, ok := p.cachedCi(paneCiKey{project: "/b", sha: "1"}); !ok || v != CiStateFailure {
		t.Fatal("another project lost its verdict")
	}
	for i := 0; i < paneMaxCi+10; i++ {
		p.storeCi(paneCiKey{project: "/c", sha: fmt.Sprint(i)}, CiStateSuccess)
	}
	if len(p.ciVerdicts) > paneMaxCi {
		t.Fatalf("%d verdicts kept", len(p.ciVerdicts))
	}
}

func TestPaneProjectsBounded(t *testing.T) {
	base := t.TempDir()
	p := MakePanes(plainRunner, nil, nil)
	for i := 0; i < paneMaxProjects+40; i++ {
		dir := filepath.Join(base, fmt.Sprintf("d%03d", i))
		os.MkdirAll(dir, 0755)
		if _, err := p.Get(PaneRequest{Dir: dir}); err != nil {
			t.Fatal(err)
		}
	}
	if len(p.projects) > paneMaxProjects {
		t.Fatalf("%d folders kept", len(p.projects))
	}
}
