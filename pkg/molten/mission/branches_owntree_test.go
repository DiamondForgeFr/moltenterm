// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type ownTreeFixture struct {
	r       *Runs
	dir     string
	trees   string
	devTree string
}

func (f ownTreeFixture) tree(n int) string {
	return filepath.Join(f.trees, fmt.Sprintf("work-%d", n))
}

// #906's cases: worktrees MoltenTerm made for merged pull requests (10 clean with ignored files, 11 with an
// uncommitted change, 12 with a terminal open in it), one the developer made (13), a branch the batch merge rebased
// before merging it (14), one with a commit its pull request never carried (15), and the tool branches.
func makeOwnTreeFixture(t *testing.T) ownTreeFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	origin := t.TempDir()
	gitIn(t, origin, "init", "-q", "--bare", "-b", "develop")
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", origin)
	commitFile(t, dir, ".gitignore", "node_modules/\n", "init")
	gitIn(t, dir, "branch", "main")
	for _, n := range []int{10, 11, 12, 13} {
		name := fmt.Sprintf("feature/%d-tree", n)
		gitIn(t, dir, "checkout", "-q", "-b", name, "develop")
		commitFile(t, dir, fmt.Sprintf("%d.txt", n), name+"\n", name)
	}
	gitIn(t, dir, "checkout", "-q", "-b", "feature/14-rebased", "develop")
	commitFile(t, dir, "e.txt", "e\n", "fourteen")
	gitIn(t, dir, "tag", "pr14-before")
	gitIn(t, dir, "checkout", "-q", "-b", "feature/15-extra", "develop")
	commitFile(t, dir, "f.txt", "f\n", "fifteen")
	gitIn(t, dir, "tag", "pr15-before")
	commitFile(t, dir, "g.txt", "g\n", "fifteen, a commit the pull request never had")
	gitIn(t, dir, "checkout", "-q", "-b", "pr-assets", "develop")
	commitFile(t, dir, "shot.png", "png\n", "docs(#1): screenshot")
	gitIn(t, dir, "checkout", "-q", "-b", "deploy-cache", "develop")
	commitFile(t, dir, "cache.txt", "cache\n", "cache")

	// develop moves, then the batch merge rebases 14 and 15 with their conflicts resolved: new heads, new patches.
	gitIn(t, dir, "checkout", "-q", "develop")
	commitFile(t, dir, "e.txt", "develop\n", "develop edits e")
	for _, n := range []int{10, 11, 12, 13} {
		gitIn(t, dir, "cherry-pick", fmt.Sprintf("feature/%d-tree", n))
	}
	commitFile(t, dir, "e.txt", "e, resolved\n", "fourteen, rebased")
	gitIn(t, dir, "tag", "pr14-merged")
	commitFile(t, dir, "f.txt", "f, resolved\n", "fifteen, rebased")
	gitIn(t, dir, "tag", "pr15-merged")
	gitIn(t, dir, "push", "-q", "origin", "develop", "main", "pr-assets")
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"branches":{"tools":["deploy-cache"]}}`), 0644)

	data := t.TempDir()
	trees := filepath.Join(DepSyncTreesDir(data), "project-1a2b3c4d")
	f := ownTreeFixture{dir: dir, trees: trees, devTree: filepath.Join(t.TempDir(), "wt13")}
	for _, n := range []int{10, 11, 12} {
		gitIn(t, dir, "worktree", "add", "-q", f.tree(n), fmt.Sprintf("feature/%d-tree", n))
	}
	gitIn(t, dir, "worktree", "add", "-q", f.devTree, "feature/13-tree")
	os.MkdirAll(filepath.Join(f.tree(10), "node_modules", "x"), 0755)
	os.WriteFile(filepath.Join(f.tree(10), "node_modules", "x", "index.js"), []byte("x\n"), 0644)
	os.WriteFile(filepath.Join(f.tree(11), "10.txt"), []byte("work in progress\n"), 0644)

	heads := map[int]string{}
	for _, n := range []int{10, 11, 12, 13} {
		heads[n] = headOf(t, dir, fmt.Sprintf("feature/%d-tree", n))
	}
	heads[14], heads[15] = headOf(t, dir, "pr14-merged"), headOf(t, dir, "pr15-merged")
	before := map[int]string{14: headOf(t, dir, "pr14-before"), 15: headOf(t, dir, "pr15-before")}
	gh := func(args []string) ([]byte, error) {
		call := strings.Join(args, " ")
		switch {
		case strings.Contains(call, "--state open"):
			return []byte(`[]`), nil
		case strings.Contains(call, "--state merged"):
			var prs []string
			for n, head := range heads {
				name := fmt.Sprintf("feature/%d-tree", n)
				if n == 14 {
					name = "feature/14-rebased"
				} else if n == 15 {
					name = "feature/15-extra"
				}
				prs = append(prs, fmt.Sprintf(`{"number":%d,"headRefName":%q,"headRefOid":%q,"baseRefName":"develop"}`, n, name, head))
			}
			return []byte("[" + strings.Join(prs, ",") + "]"), nil
		case strings.HasPrefix(call, "repo view"):
			return []byte(`{"deleteBranchOnMerge":true}`), nil
		case strings.HasPrefix(call, "api graphql"):
			for n, oid := range before {
				if strings.Contains(call, fmt.Sprintf("number=%d ", n)) {
					return []byte(fmt.Sprintf(`{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[
						{"beforeCommit":{"oid":%q},"afterCommit":{"oid":%q}}]}}}}}`, oid, heads[n])), nil
				}
			}
			return []byte(`{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[]}}}}}`), nil
		}
		return nil, errors.New("unexpected gh " + call)
	}
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	t.Cleanup(func() { waitRunsIdle(t, r) })
	r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return gh(args)
		}
		return plainRunner(ctx, d, name, args...)
	}
	inUse := realPath(f.tree(12))
	r.UseWorktrees(MakeWorktrees(plainRunner, func(ctx context.Context, path string, exclude []string) []WorktreeTerminal {
		if realPath(path) == inUse {
			return []WorktreeTerminal{{BlockId: "block-12", Tab: "Review"}}
		}
		return []WorktreeTerminal{}
	}), data)
	f.r = r
	return f
}

func TestBranchesPlanOwnWorktreesRebasedAndToolBranches(t *testing.T) {
	f := makeOwnTreeFixture(t)
	plan, err := f.r.PlanBranches(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	got := planOf(plan)
	for label, want := range map[string]string{
		"feature/10-tree":    "delete:merged-pr-worktree:#10",
		"feature/11-tree":    "keep:worktree-changes:#11",
		"feature/12-tree":    "keep:worktree-in-use:#12",
		"feature/13-tree":    "keep:checked-out",
		"feature/14-rebased": "delete:merged-pr:#14",
		"feature/15-extra":   "keep:not-in-pr:#15",
		"pr-assets":          "keep:pr-assets",
		"origin/pr-assets":   "keep:pr-assets",
		"deploy-cache":       "keep:tool-branch",
		"develop":            "keep:protected",
		"origin/develop":     "keep:protected",
		"main":               "keep:protected",
		"origin/main":        "keep:protected",
	} {
		if got[label] != want {
			t.Errorf("%s: got %q, want %q", label, got[label], want)
		}
	}
	for _, b := range plan.Branches {
		if b.Name == "feature/10-tree" && !samePathForTest(b.Worktree, f.tree(10)) {
			t.Errorf("the plan names the worktree that goes: %q", b.Worktree)
		}
		if b.Name == "feature/13-tree" && b.Worktree != "" {
			t.Errorf("the developer's worktree is never offered: %q", b.Worktree)
		}
	}
}

func TestBranchesPlanWithoutForcePushHistoryKeepsTheRebasedBranch(t *testing.T) {
	f := makeOwnTreeFixture(t)
	git := f.r.git
	f.r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" && len(args) > 0 && args[0] == "api" {
			return nil, errors.New("gh api: offline")
		}
		return git(ctx, d, name, args...)
	}
	plan, _ := f.r.PlanBranches(f.dir)
	if got := planOf(plan)["feature/14-rebased"]; got != "keep:not-in-pr:#14" {
		t.Fatalf("GitHub did not give the earlier heads: %s", got)
	}
}

func TestCleanBranchesRemovesOwnWorktreeOfMergedPr(t *testing.T) {
	f := makeOwnTreeFixture(t)
	res, err := f.r.CleanBranches(BranchesCleanRequest{Dir: f.dir, Names: []string{"feature/10-tree", "feature/11-tree",
		"feature/12-tree", "feature/13-tree", "feature/14-rebased", "pr-assets"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Deleted, ",") != "feature/10-tree,feature/14-rebased" || res.Failed != 5 {
		t.Fatalf("clean: %+v", res)
	}
	if _, err := os.Stat(f.tree(10)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the clean worktree's folder is gone: %v", err)
	}
	for _, kept := range []string{f.tree(11), f.tree(12), f.devTree} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("%s stays: %v", kept, err)
		}
	}
	branches := gitIn(t, f.dir, "branch", "-a")
	if strings.Contains(branches, "feature/10-tree") || strings.Contains(branches, "feature/14-rebased") {
		t.Fatalf("the branches went: %s", branches)
	}
	for _, kept := range []string{"feature/11-tree", "feature/12-tree", "feature/13-tree", "pr-assets"} {
		if !strings.Contains(branches, kept) {
			t.Fatalf("%s stays: %s", kept, branches)
		}
	}
	if strings.Contains(gitIn(t, f.dir, "worktree", "list"), "work-10") {
		t.Fatal("git no longer lists the removed worktree")
	}
}

func TestCleanBranchesKeepsOwnWorktreeThatChangedSinceThePlan(t *testing.T) {
	f := makeOwnTreeFixture(t)
	git := f.r.git
	// A file lands in the worktree after the plan read it (14 is planned after 10): the removal reads it again and refuses.
	f.r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		out, err := git(ctx, d, name, args...)
		if name == "gh" && strings.Contains(strings.Join(args, " "), "number=14 ") {
			os.WriteFile(filepath.Join(f.tree(10), "notes.txt"), []byte("new\n"), 0644)
		}
		return out, err
	}
	res, _ := f.r.CleanBranches(BranchesCleanRequest{Dir: f.dir, Names: []string{"feature/10-tree"}})
	if len(res.Deleted) != 0 {
		t.Fatalf("a worktree with new work stays: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(f.tree(10), "notes.txt")); err != nil {
		t.Fatalf("the new work is still there: %v", err)
	}
}

func TestOwnTreeIsOnlyMoltenTermsWorkFolder(t *testing.T) {
	data := t.TempDir()
	trees := DepSyncTreesDir(data)
	for path, want := range map[string]bool{
		filepath.Join(trees, "proj-1a2b", "work-766"):           true,
		filepath.Join(trees, "proj-1a2b", "work-766-2"):         true,
		filepath.Join(trees, "proj-1a2b", "review-766"):         false,
		filepath.Join(trees, "work-766"):                        false,
		filepath.Join(trees, "a", "b", "work-766"):              false,
		filepath.Join(data, ".claude", "worktrees", "work-766"): false,
	} {
		if got := ownTree(data, path); got != want {
			t.Errorf("%s: got %v, want %v", path, got, want)
		}
	}
	if ownTree("", filepath.Join(trees, "proj", "work-1")) {
		t.Error("without the data folder, no worktree is MoltenTerm's")
	}
}

func samePathForTest(a string, b string) bool {
	return realPath(a) == realPath(b)
}
