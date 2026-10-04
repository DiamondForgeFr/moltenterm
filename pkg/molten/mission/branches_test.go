// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func commitFile(t *testing.T, dir string, file string, content string, msg string) {
	t.Helper()
	os.WriteFile(filepath.Join(dir, file), []byte(content), 0644)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", msg)
}

// A project with a remote: develop and main, a branch rebase-merged into develop, one with work not merged, one in
// conflict with develop, one checked out in a worktree and one with an open pull request.
func makeBranchesFixture(t *testing.T, gh func() ([]byte, error)) (*Runs, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	origin := t.TempDir()
	gitIn(t, origin, "init", "-q", "--bare", "-b", "develop")
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", origin)
	commitFile(t, dir, "a.txt", "a\n", "init")
	gitIn(t, dir, "branch", "main")
	for _, name := range []string{"feature/1-merged", "feature/2-open", "feature/3-conflict", "feature/4-worktree", "feature/5-pr"} {
		gitIn(t, dir, "checkout", "-q", "-b", name, "develop")
		switch name {
		case "feature/3-conflict":
			commitFile(t, dir, "a.txt", "theirs\n", name)
		default:
			commitFile(t, dir, strings.TrimPrefix(name, "feature/")+".txt", name+"\n", name)
		}
	}
	gitIn(t, dir, "checkout", "-q", "develop")
	commitFile(t, dir, "a.txt", "ours\n", "develop moves")
	for _, name := range []string{"feature/1-merged", "feature/4-worktree", "feature/5-pr"} {
		gitIn(t, dir, "cherry-pick", name)
	}
	gitIn(t, dir, "push", "-q", "origin", "develop", "main", "feature/1-merged", "feature/2-open")
	gitIn(t, dir, "worktree", "add", "-q", filepath.Join(t.TempDir(), "wt"), "feature/4-worktree")
	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return gh()
		}
		return plainRunner(ctx, d, name, args...)
	}
	return r, dir
}

func planOf(plan BranchesPlan) map[string]string {
	rtn := map[string]string{}
	for _, b := range plan.Branches {
		fate := b.Action
		if b.Reason != "" {
			fate += ":" + b.Reason
		}
		rtn[branchLabel(b)] = fate
	}
	return rtn
}

func TestBranchesPlanJudgesOnContent(t *testing.T) {
	r, dir := makeBranchesFixture(t, func() ([]byte, error) { return []byte(`[{"headRefName":"feature/5-pr"}]`), nil })
	plan, err := r.PlanBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"develop":                 "keep:protected",
		"origin/develop":          "keep:protected",
		"main":                    "keep:protected",
		"origin/main":             "keep:protected",
		"feature/1-merged":        "delete",
		"origin/feature/1-merged": "delete",
		"feature/2-open":          "keep:not-on-trunk",
		"origin/feature/2-open":   "keep:not-on-trunk",
		"feature/3-conflict":      "keep:not-on-trunk",
		"feature/4-worktree":      "keep:checked-out",
		"feature/5-pr":            "keep:open-pr",
	}
	if got := planOf(plan); !reflect.DeepEqual(got, want) {
		t.Fatalf("plan:\n got %v\nwant %v", got, want)
	}
	if plan.Trunk != "develop" {
		t.Fatalf("trunk: %q", plan.Trunk)
	}
}

func TestBranchesPlanKeepsAllWhenGithubIsSilent(t *testing.T) {
	r, dir := makeBranchesFixture(t, func() ([]byte, error) { return nil, errors.New("gh: offline") })
	plan, err := r.PlanBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := planOf(plan)["feature/1-merged"]; got != "keep:pr-unknown" {
		t.Fatalf("GitHub did not answer: %s", got)
	}
}

func TestCleanBranchesChecksEachAgain(t *testing.T) {
	r, dir := makeBranchesFixture(t, func() ([]byte, error) { return []byte(`[]`), nil })
	if _, err := r.CleanBranches(BranchesCleanRequest{Dir: dir, Names: []string{"--force"}}); err == nil {
		t.Fatal("an option is not a branch name")
	}
	res, err := r.CleanBranches(BranchesCleanRequest{Dir: dir, Names: []string{"feature/1-merged", "feature/2-open"}})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(res.Deleted)
	if !reflect.DeepEqual(res.Deleted, []string{"feature/1-merged", "origin/feature/1-merged"}) || res.Failed != 2 {
		t.Fatalf("clean: %+v", res)
	}
	if strings.Contains(gitIn(t, dir, "branch", "-a"), "1-merged") {
		t.Fatal("the merged branch is gone, locally and on the remote")
	}
	if !strings.Contains(gitIn(t, dir, "branch", "-a"), "feature/2-open") {
		t.Fatal("a branch the plan keeps is never deleted")
	}
}

func TestBranchesPlanWithoutGithubRemote(t *testing.T) {
	r, dir := makeBranchesFixture(t, func() ([]byte, error) {
		return nil, errors.New("gh pr list: none of the git remotes configured for this repository point to a known GitHub host")
	})
	plan, _ := r.PlanBranches(dir)
	if got := planOf(plan)["feature/1-merged"]; got != "delete" {
		t.Fatalf("no GitHub remote, no pull request: %s", got)
	}
}
