// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParsePaneStatus(t *testing.T) {
	out := strings.Join([]string{
		"# branch.oid 4f2a9c0d",
		"# branch.head feature/108-status",
		"# branch.upstream origin/feature/108-status",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 abc abc frontend/x.ts",
	}, "\n")
	st := parsePaneStatus(out)
	if st.sha != "4f2a9c0d" || st.branch != "feature/108-status" || st.upstream != "origin/feature/108-status" {
		t.Fatalf("head: %+v", st)
	}
	if st.ahead != 2 || st.behind != 1 || !st.dirty || st.detached {
		t.Fatalf("counts: %+v", st)
	}
	clean := parsePaneStatus("# branch.oid (initial)\n# branch.head (detached)\n")
	if clean.sha != "" || !clean.detached || clean.branch != "" || clean.dirty {
		t.Fatalf("initial detached: %+v", clean)
	}
}

func TestMatchPullRequest(t *testing.T) {
	raw := json.RawMessage(`[{"number":7,"title":"Other","url":"u7","headRefName":"feature/7-x"},
		{"number":108,"title":"Status bar","url":"u108","headRefName":"feature/108-status","isDraft":true}]`)
	pr := matchPullRequest(raw, "feature/108-status")
	if pr == nil || pr.Number != 108 || !pr.Draft || pr.Url != "u108" {
		t.Fatalf("pr: %+v", pr)
	}
	if matchPullRequest(raw, "develop") != nil || matchPullRequest(nil, "develop") != nil {
		t.Fatal("a branch without a pull request matched one")
	}
}

func makePaneRepo(t *testing.T) (string, string) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	base := t.TempDir()
	origin := filepath.Join(base, "origin")
	os.MkdirAll(origin, 0755)
	gitRun(t, origin, "init", "-q", "-b", "develop")
	commit(t, origin, "a.txt", "feat(#1): first")
	clone := filepath.Join(base, "clone")
	gitRun(t, base, "clone", "-q", origin, clone)
	return base, clone
}

func TestPaneStateFollowsTheTree(t *testing.T) {
	base, clone := makePaneRepo(t)
	panes := MakePanes(plainRunner, nil, nil)
	sub := filepath.Join(clone, "src")
	os.MkdirAll(sub, 0755)
	state, err := panes.Get(PaneRequest{Dir: sub})
	if err != nil {
		t.Fatal(err)
	}
	if state.Dir != sub || state.Root != clone || state.Project != clone || state.Branch != "develop" {
		t.Fatalf("clean clone: %+v", state)
	}
	if state.Ahead != 0 || state.Dirty || state.Upstream != "origin/develop" || state.Name != "clone" {
		t.Fatalf("clean clone: %+v", state)
	}

	commit(t, clone, "b.txt", "feat(#2): second")
	os.WriteFile(filepath.Join(clone, "c.txt"), []byte("draft"), 0644)
	panes.now = func() time.Time { return time.Now().Add(2 * time.Second) }
	state, _ = panes.Get(PaneRequest{Dir: clone})
	if state.Ahead != 1 || !state.Dirty {
		t.Fatalf("one commit ahead, untracked file: %+v", state)
	}

	// A worktree belongs to its repository's main checkout: that is where Mission Control keeps the project.
	tree := filepath.Join(base, "wt")
	gitRun(t, clone, "worktree", "add", "-q", "-b", "feature/9-x", tree)
	state, _ = panes.Get(PaneRequest{Dir: tree})
	resolved, _ := filepath.EvalSymlinks(clone)
	project, _ := filepath.EvalSymlinks(state.Project)
	if state.Root != tree || project != resolved || state.Branch != "feature/9-x" || state.Upstream != "" {
		t.Fatalf("worktree: %+v", state)
	}
	if state.Ahead != 1 {
		t.Fatalf("a branch without upstream counts the commits no remote has: %+v", state)
	}
}

func TestPaneOutsideARepository(t *testing.T) {
	dir := t.TempDir()
	state, err := MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if state.Root != "" || state.Branch != "" || state.Name != filepath.Base(dir) {
		t.Fatalf("plain folder: %+v", state)
	}
	if _, err := MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: "relative"}); err == nil {
		t.Fatal("a relative folder was accepted")
	}
}

func TestPaneProbesAtMostOnceASecond(t *testing.T) {
	_, clone := makePaneRepo(t)
	var statuses atomic.Int32
	counting := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		for _, arg := range args {
			if arg == "status" {
				statuses.Add(1)
			}
		}
		return plainRunner(ctx, dir, name, args...)
	}
	panes := MakePanes(counting, nil, nil)
	clock := time.Now()
	panes.now = func() time.Time { return clock }
	var slept time.Duration
	panes.sleep = func(d time.Duration) {
		slept += d
		clock = clock.Add(d)
	}
	panes.Get(PaneRequest{Dir: clone})
	clock = clock.Add(300 * time.Millisecond)
	panes.Get(PaneRequest{Dir: filepath.Join(clone, ".")})
	if statuses.Load() != 1 {
		t.Fatalf("two requests within a second probed %d times", statuses.Load())
	}
	// After a cd or a prompt, the answer waits for the end of the window rather than returning the old probe.
	panes.Get(PaneRequest{Dir: clone, Fresh: true})
	if statuses.Load() != 2 || slept != 700*time.Millisecond {
		t.Fatalf("fresh request: %d probes, slept %v", statuses.Load(), slept)
	}
	clock = clock.Add(time.Second)
	panes.Get(PaneRequest{Dir: clone})
	if statuses.Load() != 3 {
		t.Fatalf("a request after the window did not probe: %d", statuses.Load())
	}
}

func TestPaneReadsTheCollectorCacheOnly(t *testing.T) {
	_, clone := makePaneRepo(t)
	gitRun(t, clone, "checkout", "-q", "-b", "feature/108-status")
	cacheDir := t.TempDir()
	collector := MakeCollector(cacheDir, plainRunner, nil)
	panes := MakePanes(plainRunner, nil, collector)
	state, _ := panes.Get(PaneRequest{Dir: clone})
	if state.Pr != nil {
		t.Fatalf("no snapshot, yet a pull request: %+v", state.Pr)
	}
	if len(collector.projects) != 0 {
		t.Fatal("asking about a folder created a collector project")
	}
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{
		State: GithubStateOk,
		Prs:   json.RawMessage(`[{"number":108,"title":"Status bar","url":"u","headRefName":"feature/108-status"}]`),
	}})
	panes.now = func() time.Time { return time.Now().Add(2 * time.Second) }
	state, _ = panes.Get(PaneRequest{Dir: clone})
	if state.Pr == nil || state.Pr.Number != 108 {
		t.Fatalf("pull request from the cached snapshot: %+v", state)
	}
	if collector.projects[clone].refreshing {
		t.Fatal("reading the cache started a refresh")
	}
}

func TestParseHeads(t *testing.T) {
	out := strings.Join([]string{
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/feature/109-loader",
		"refs/heads/feature/109-loader",
		"refs/remotes/upstream/develop",
		"refs/heads/develop",
		"",
	}, "\n")
	heads := parseHeads(out)
	want := []string{"feature/109-loader", "develop"}
	if strings.Join(heads, ",") != strings.Join(want, ",") {
		t.Fatalf("heads: %v", heads)
	}
	if parseHeads("") != nil {
		t.Fatal("no ref, yet heads")
	}
}

func TestPickDetachedBranch(t *testing.T) {
	prs := parsePanePrs(json.RawMessage(`[{"number":7,"title":"Seven","url":"u7","headRefName":"feature/7-x","headRefOid":"aaa"},
		{"number":9,"title":"Nine","url":"u9","headRefName":"feature/9-y","headRefOid":"bbb","isDraft":true}]`))
	branch, pr := pickDetachedBranch(prs, []string{"develop", "feature/9-y"}, "bbb")
	if branch != "feature/9-y" || pr == nil || pr.Number != 9 || !pr.Draft {
		t.Fatalf("the branch with a PR wins: %q %+v", branch, pr)
	}
	branch, pr = pickDetachedBranch(prs, nil, "aaa")
	if branch != "feature/7-x" || pr == nil || pr.Number != 7 {
		t.Fatalf("the PR whose head is HEAD: %q %+v", branch, pr)
	}
	branch, pr = pickDetachedBranch(prs, []string{"develop", "main"}, "ccc")
	if branch != "develop" || pr != nil {
		t.Fatalf("the first branch, no PR: %q %+v", branch, pr)
	}
	branch, pr = pickDetachedBranch(nil, nil, "ccc")
	if branch != "" || pr != nil {
		t.Fatalf("a commit no branch points to: %q %+v", branch, pr)
	}
}

// The reported case: a checkout detached at origin/<branch> because another worktree holds the branch.
func TestPaneDetachedAtABranchHeldByAWorktree(t *testing.T) {
	base, clone := makePaneRepo(t)
	gitRun(t, clone, "checkout", "-q", "-b", "feature/109-loader")
	commit(t, clone, "l.txt", "feat(#109): loader")
	gitRun(t, clone, "push", "-q", "origin", "feature/109-loader")
	gitRun(t, clone, "checkout", "-q", "develop")
	gitRun(t, clone, "worktree", "add", "-q", filepath.Join(base, "agent"), "feature/109-loader")
	gitRun(t, clone, "checkout", "-q", "--detach", "origin/feature/109-loader")

	cacheDir := t.TempDir()
	collector := MakeCollector(cacheDir, plainRunner, nil)
	collector.saveCache(Snapshot{Dir: clone, Github: &GithubSnapshot{
		State: GithubStateOk,
		Prs:   json.RawMessage(`[{"number":109,"title":"Loader","url":"u109","headRefName":"feature/109-loader"}]`),
	}})
	panes := MakePanes(plainRunner, nil, collector)
	state, err := panes.Get(PaneRequest{Dir: clone})
	if err != nil {
		t.Fatal(err)
	}
	if !state.Detached || state.Branch != "" || state.GitError != "" {
		t.Fatalf("detached checkout: %+v", state)
	}
	if state.DetachedBranch != "feature/109-loader" || state.Pr == nil || state.Pr.Number != 109 || !state.PrKnown {
		t.Fatalf("detached at the PR branch: %+v", state)
	}

	// A commit made on the detached HEAD is on no branch: the short SHA stays, no PR, no error.
	commit(t, clone, "x.txt", "chore(#109): try")
	panes.now = func() time.Time { return time.Now().Add(2 * time.Second) }
	state, _ = panes.Get(PaneRequest{Dir: clone})
	if !state.Detached || state.DetachedBranch != "" || state.Pr != nil || state.GitError != "" || state.Sha == "" {
		t.Fatalf("detached on no branch: %+v", state)
	}
	if state.PrKnown {
		t.Fatalf("a commit on no branch waits for no PR: %+v", state)
	}

	// A feature branch without a PR waits for one; the trunk never does.
	gitRun(t, clone, "checkout", "-q", "-b", "feature/110-next")
	panes.now = func() time.Time { return time.Now().Add(4 * time.Second) }
	state, _ = panes.Get(PaneRequest{Dir: clone})
	if state.Branch != "feature/110-next" || state.Pr != nil || !state.PrKnown {
		t.Fatalf("a branch with no PR yet: %+v", state)
	}
	gitRun(t, clone, "checkout", "-q", "develop")
	panes.now = func() time.Time { return time.Now().Add(6 * time.Second) }
	state, _ = panes.Get(PaneRequest{Dir: clone})
	if state.Branch != "develop" || state.PrKnown {
		t.Fatalf("the trunk waits for no PR: %+v", state)
	}
}

func TestPaneFolderAboveARepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	parent := t.TempDir()
	repo := filepath.Join(parent, "diamondforge")
	os.MkdirAll(repo, 0755)
	gitRun(t, repo, "init", "-q", "-b", "develop")
	commit(t, repo, "a.txt", "feat(#1): first")
	os.MkdirAll(filepath.Join(parent, "notes"), 0755)
	os.MkdirAll(filepath.Join(parent, ".hidden", ".git"), 0755)

	state, err := MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: parent})
	if err != nil {
		t.Fatal(err)
	}
	if !state.Below || state.Root != repo || state.Branch != "develop" || state.Name != "diamondforge" || state.Dir != parent {
		t.Fatalf("the only repository below the folder: %+v", state)
	}

	// Two repositories: the bar cannot tell which one the session works in, so it names none.
	other := filepath.Join(parent, "other")
	os.MkdirAll(other, 0755)
	gitRun(t, other, "init", "-q", "-b", "main")
	state, _ = MakePanes(plainRunner, nil, nil).Get(PaneRequest{Dir: parent})
	if state.Below || state.Root != "" || state.Branch != "" || state.Name != filepath.Base(parent) {
		t.Fatalf("two repositories below: %+v", state)
	}
}
