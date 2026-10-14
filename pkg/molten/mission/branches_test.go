// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
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

func headOf(t *testing.T, dir string, ref string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, dir, "rev-parse", ref))
}

// A project with a remote: develop and main, a branch rebase-merged into develop, one with work not merged, one in
// conflict with develop, one checked out in a worktree and one with an open pull request. Then the cases of #571:
// a pull request merged long ago whose re-merge now conflicts (6), one with a commit pushed after its merge (7), a
// branch with no pull request whose commits reached develop under new ids before develop edited the same lines (8)
// and one merged into another feature branch, not into a main branch (9).
func makeBranchesFixture(t *testing.T, gh func(dir string, args []string) ([]byte, error)) (*Runs, string) {
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
	gitIn(t, dir, "checkout", "-q", "-b", "feature/6-old-pr", "develop")
	commitFile(t, dir, "six.txt", "six draft\n", "six, first")
	commitFile(t, dir, "six.txt", "six\n", "six, second")
	gitIn(t, dir, "checkout", "-q", "-b", "feature/7-after", "develop")
	commitFile(t, dir, "seven.txt", "seven\n", "seven")
	gitIn(t, dir, "checkout", "-q", "-b", "feature/8-patches", "develop")
	commitFile(t, dir, "eight.txt", "eight\n", "eight")
	gitIn(t, dir, "checkout", "-q", "-b", "feature/9-stacked", "feature/2-open")
	commitFile(t, dir, "nine.txt", "nine\n", "nine")

	gitIn(t, dir, "checkout", "-q", "develop")
	commitFile(t, dir, "a.txt", "ours\n", "develop moves")
	for _, name := range []string{"feature/1-merged", "feature/4-worktree", "feature/5-pr", "feature/7-after", "feature/8-patches"} {
		gitIn(t, dir, "cherry-pick", name)
	}
	// #6 reaches develop as a single commit (its two commits squashed by a rebase), then develop edits the same files:
	// neither the content nor the patch ids can tell any more.
	commitFile(t, dir, "six.txt", "six\n", "six, squashed")
	commitFile(t, dir, "six.txt", "six, later\n", "develop edits six")
	commitFile(t, dir, "eight.txt", "eight, later\n", "develop edits eight")
	gitIn(t, dir, "checkout", "-q", "feature/7-after")
	gitIn(t, dir, "tag", "pr7-head")
	commitFile(t, dir, "seven.txt", "seven, after the merge\n", "seven, after")
	gitIn(t, dir, "checkout", "-q", "develop")
	gitIn(t, dir, "push", "-q", "origin", "develop", "main", "feature/1-merged", "feature/2-open", "feature/6-old-pr",
		"feature/7-after", "feature/8-patches")
	gitIn(t, dir, "worktree", "add", "-q", filepath.Join(t.TempDir(), "wt"), "feature/4-worktree")
	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	t.Cleanup(func() { waitRunsIdle(t, r) })
	r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return gh(d, args)
		}
		return plainRunner(ctx, d, name, args...)
	}
	return r, dir
}

// githubFake answers as GitHub would for the fixture: the open pull request of #5, the merged ones of #1, #6, #7 (its
// head before the extra commit) and #9 (merged into feature/2-open), and the repository setting.
func githubFake(t *testing.T, autoDelete bool, edits *[]string) func(dir string, args []string) ([]byte, error) {
	return func(dir string, args []string) ([]byte, error) {
		call := strings.Join(args, " ")
		switch {
		case strings.Contains(call, "--state open"):
			return []byte(`[{"headRefName":"feature/5-pr"}]`), nil
		case strings.Contains(call, "--state merged"):
			return []byte(fmt.Sprintf(`[
				{"number":1,"headRefName":"feature/1-merged","headRefOid":%q,"baseRefName":"develop"},
				{"number":6,"headRefName":"feature/6-old-pr","headRefOid":%q,"baseRefName":"develop"},
				{"number":7,"headRefName":"feature/7-after","headRefOid":%q,"baseRefName":"develop"},
				{"number":9,"headRefName":"feature/9-stacked","headRefOid":%q,"baseRefName":"feature/2-open"}]`,
				headOf(t, dir, "feature/1-merged"), headOf(t, dir, "feature/6-old-pr"), headOf(t, dir, "pr7-head"),
				headOf(t, dir, "feature/9-stacked"))), nil
		case strings.HasPrefix(call, "repo view"):
			return []byte(fmt.Sprintf(`{"deleteBranchOnMerge":%v}`, autoDelete)), nil
		case strings.HasPrefix(call, "repo edit"):
			*edits = append(*edits, call)
			return nil, nil
		}
		return nil, errors.New("unexpected gh " + call)
	}
}

func planOf(plan BranchesPlan) map[string]string {
	rtn := map[string]string{}
	for _, b := range plan.Branches {
		fate := b.Action
		if b.Reason != "" {
			fate += ":" + b.Reason
		}
		if b.Pr > 0 {
			fate += fmt.Sprintf(":#%d", b.Pr)
		}
		rtn[branchLabel(b)] = fate
	}
	return rtn
}

func TestBranchesPlanReadsMergedPullRequests(t *testing.T) {
	var edits []string
	r, dir := makeBranchesFixture(t, githubFake(t, true, &edits))
	plan, err := r.PlanBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"develop":                  "keep:protected",
		"origin/develop":           "keep:protected",
		"main":                     "keep:protected",
		"origin/main":              "keep:protected",
		"feature/1-merged":         "delete:merged-pr:#1",
		"origin/feature/1-merged":  "delete:merged-pr:#1",
		"feature/2-open":           "keep:not-on-trunk",
		"origin/feature/2-open":    "keep:not-on-trunk",
		"feature/3-conflict":       "keep:not-on-trunk",
		"feature/4-worktree":       "keep:checked-out",
		"feature/5-pr":             "keep:open-pr",
		"feature/6-old-pr":         "delete:merged-pr:#6",
		"origin/feature/6-old-pr":  "delete:merged-pr:#6",
		"feature/7-after":          "keep:commits-after-pr:#7",
		"origin/feature/7-after":   "keep:commits-after-pr:#7",
		"feature/8-patches":        "delete:patches-on-trunk",
		"origin/feature/8-patches": "delete:patches-on-trunk",
		"feature/9-stacked":        "keep:not-on-trunk",
	}
	if got := planOf(plan); !reflect.DeepEqual(got, want) {
		t.Fatalf("plan:\n got %v\nwant %v", got, want)
	}
	if plan.Trunk != "develop" || plan.AutoDeleteOffer {
		t.Fatalf("trunk %q, offer %v", plan.Trunk, plan.AutoDeleteOffer)
	}
}

func TestBranchesPlanJudgesOnContentWithoutPullRequests(t *testing.T) {
	r, dir := makeBranchesFixture(t, func(dir string, args []string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "--state open") {
			return []byte(`[{"headRefName":"feature/5-pr"}]`), nil
		}
		return []byte(`[]`), nil
	})
	plan, err := r.PlanBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := planOf(plan)
	for label, want := range map[string]string{
		"feature/1-merged":  "delete:on-trunk",
		"feature/6-old-pr":  "keep:not-on-trunk",
		"feature/7-after":   "keep:not-on-trunk",
		"feature/8-patches": "delete:patches-on-trunk",
		"feature/2-open":    "keep:not-on-trunk",
		"feature/5-pr":      "keep:open-pr",
	} {
		if got[label] != want {
			t.Fatalf("%s: got %s, want %s", label, got[label], want)
		}
	}
}

func TestBranchesPlanKeepsAllWhenGithubIsSilent(t *testing.T) {
	r, dir := makeBranchesFixture(t, func(string, []string) ([]byte, error) { return nil, errors.New("gh: offline") })
	plan, err := r.PlanBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := planOf(plan)
	for label, want := range map[string]string{
		"feature/1-merged":  "keep:pr-unknown",
		"feature/8-patches": "keep:pr-unknown",
		"feature/6-old-pr":  "keep:not-on-trunk",
	} {
		if got[label] != want {
			t.Fatalf("GitHub did not answer, %s: got %s, want %s", label, got[label], want)
		}
	}
	if plan.AutoDeleteOffer {
		t.Fatal("no offer when GitHub did not say")
	}
}

func TestBranchesPlanTrustsNoMergedPrWhenOpenPrsAreUnknown(t *testing.T) {
	var edits []string
	full := githubFake(t, true, &edits)
	r, dir := makeBranchesFixture(t, func(dir string, args []string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "--state open") {
			return nil, errors.New("gh: rate limited")
		}
		return full(dir, args)
	})
	plan, _ := r.PlanBranches(dir)
	if got := planOf(plan)["feature/6-old-pr"]; got != "keep:not-on-trunk" {
		t.Fatalf("a pull request may be open on it: %s", got)
	}
}

func TestCleanBranchesChecksEachAgain(t *testing.T) {
	var edits []string
	r, dir := makeBranchesFixture(t, githubFake(t, true, &edits))
	if _, err := r.CleanBranches(BranchesCleanRequest{Dir: dir, Names: []string{"--force"}}); err == nil {
		t.Fatal("an option is not a branch name")
	}
	res, err := r.CleanBranches(BranchesCleanRequest{Dir: dir, Names: []string{"feature/6-old-pr", "feature/2-open", "feature/7-after"}})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(res.Deleted)
	if !reflect.DeepEqual(res.Deleted, []string{"feature/6-old-pr", "origin/feature/6-old-pr"}) || res.Failed != 4 {
		t.Fatalf("clean: %+v", res)
	}
	branches := gitIn(t, dir, "branch", "-a")
	if strings.Contains(branches, "6-old-pr") {
		t.Fatal("the merged branch is gone, locally and on the remote")
	}
	if !strings.Contains(branches, "feature/2-open") || !strings.Contains(branches, "feature/7-after") {
		t.Fatal("a branch the plan keeps is never deleted")
	}
}

func TestBranchesPlanWithoutGithubRemote(t *testing.T) {
	r, dir := makeBranchesFixture(t, func(string, []string) ([]byte, error) {
		return nil, errors.New("gh pr list: none of the git remotes configured for this repository point to a known GitHub host")
	})
	plan, _ := r.PlanBranches(dir)
	got := planOf(plan)
	if got["feature/1-merged"] != "delete:on-trunk" || got["feature/8-patches"] != "delete:patches-on-trunk" {
		t.Fatalf("no GitHub remote, no pull request: %v", got)
	}
	if plan.AutoDeleteOffer {
		t.Fatal("no GitHub, no offer")
	}
}

func TestBranchesAutoDeleteOfferIsMadeOnce(t *testing.T) {
	var edits []string
	r, dir := makeBranchesFixture(t, githubFake(t, false, &edits))
	plan, _ := r.PlanBranches(dir)
	if !plan.AutoDeleteOffer {
		t.Fatal("the repository keeps head branches: the offer is made")
	}
	if len(edits) != 0 {
		t.Fatal("the setting never changes without a click")
	}
	if err := r.AnswerAutoDelete(BranchesAutoDeleteRequest{Dir: dir, Enable: true}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(edits, []string{"repo edit --delete-branch-on-merge"}) {
		t.Fatalf("Turn on: %v", edits)
	}
	if plan, _ := r.PlanBranches(dir); plan.AutoDeleteOffer {
		t.Fatal("answered: not offered again")
	}
}

func TestBranchesAutoDeleteNotNowChangesNothing(t *testing.T) {
	var edits []string
	r, dir := makeBranchesFixture(t, githubFake(t, false, &edits))
	if err := r.AnswerAutoDelete(BranchesAutoDeleteRequest{Dir: dir, Enable: false}); err != nil {
		t.Fatal(err)
	}
	plan, _ := r.PlanBranches(dir)
	if plan.AutoDeleteOffer || len(edits) != 0 {
		t.Fatalf("Not now: offer %v, edits %v", plan.AutoDeleteOffer, edits)
	}
}

func TestBranchesAutoDeleteFailureIsNotAnAnswer(t *testing.T) {
	r, dir := makeBranchesFixture(t, func(dir string, args []string) ([]byte, error) {
		call := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(call, "repo edit"):
			return nil, errors.New("HTTP 403: admin rights needed")
		case strings.HasPrefix(call, "repo view"):
			return []byte(`{"deleteBranchOnMerge":false}`), nil
		}
		return []byte(`[]`), nil
	})
	if err := r.AnswerAutoDelete(BranchesAutoDeleteRequest{Dir: dir, Enable: true}); err == nil {
		t.Fatal("the failure is reported")
	}
	if plan, _ := r.PlanBranches(dir); !plan.AutoDeleteOffer {
		t.Fatal("a failed Turn on leaves the offer up")
	}
}
