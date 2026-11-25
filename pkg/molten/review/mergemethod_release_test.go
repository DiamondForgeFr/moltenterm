// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2562: a sync-back or release-candidate pull request merges with a merge commit, whatever method is remembered for
// the repository; another method asks for confirmation, and the remembered method is left alone.

func releaseKindAlways(kind string) func(dir string, head string, base string) string {
	return func(dir string, head string, base string) string { return kind }
}

func releaseMerger(t *testing.T, kind string, repo string, last string) (*Merger, string, *fakeGh) {
	t.Helper()
	gh := &fakeGh{views: []fakePr{cleanPr()}, repo: repo}
	m, dir, _ := testMerger(t, gh)
	m.releaseKind = releaseKindAlways(kind)
	if last != "" {
		if err := m.store.SetLastMergeMethod(testRepo, last); err != nil {
			t.Fatal(err)
		}
	}
	return m, dir, gh
}

func TestReleasePrDefaultsToMergeCommit(t *testing.T) {
	t.Parallel()
	SetPostMerge(nil)
	for _, kind := range []string{molten.ReleasePrSyncBack, molten.ReleasePrRc} {
		for _, last := range []string{MergeMethodRebase, MergeMethodSquash} {
			t.Run(kind+"-"+last, func(t *testing.T) {
				m, dir, gh := releaseMerger(t, kind, allAllowed, last)
				plan, err := m.Plan(context.Background(), planReq(dir))
				if err != nil {
					t.Fatal(err)
				}
				if plan.Release != kind || plan.Method != MergeMethodMerge || plan.MethodRefused != "" {
					t.Fatalf("a release PR defaults to a merge commit: release %q, method %s, refused %q", plan.Release, plan.Method, plan.MethodRefused)
				}
				if !slices.Equal(plan.Methods, allMergeMethods) {
					t.Fatalf("the other methods stay offered: %v", plan.Methods)
				}
				if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
					t.Fatalf("the merge commit needs no confirmation: %v", err)
				}
				m.wait(testKey)
				state, _ := m.store.Get(testKey)
				if state.Merge.Method != MergeMethodMerge || state.Merge.Release != kind || !strings.Contains(mergeCall(t, gh), " --merge ") {
					t.Fatalf("merged with %s (%s), release %q", state.Merge.Method, mergeCall(t, gh), state.Merge.Release)
				}
				if got, _ := m.store.LastMergeMethod(testRepo); got != last {
					t.Errorf("the remembered method is unchanged: %s, was %s", got, last)
				}
			})
		}
	}
}

func TestReleasePrOtherMethodAsksFirst(t *testing.T) {
	t.Parallel()
	SetPostMerge(nil)
	for _, method := range []string{MergeMethodSquash, MergeMethodRebase} {
		t.Run(method, func(t *testing.T) {
			m, dir, gh := releaseMerger(t, molten.ReleasePrSyncBack, allAllowed, MergeMethodSquash)
			plan, err := m.Plan(context.Background(), planReq(dir))
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.Warnings) != 0 {
				t.Fatalf("a clean release PR has no warning of its own: %v", plan.Warnings)
			}
			_, err = m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: method})
			if err == nil || err.Error() != mergeError(MergeErrConfirm).Error() {
				t.Fatalf("%s on a release PR asks for confirmation, got %v", method, err)
			}
			if len(gh.writes()) != 0 {
				t.Fatalf("nothing is merged before the confirmation: %v", gh.writes())
			}
			if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: method, Override: true}); err != nil {
				t.Fatalf("never blocked: the confirmed %s merges, got %v", method, err)
			}
			m.wait(testKey)
			state, _ := m.store.Get(testKey)
			if state.Merge.Method != method || !strings.Contains(mergeCall(t, gh), " --"+method+" ") {
				t.Fatalf("merged with %s (%s), confirmed %s", state.Merge.Method, mergeCall(t, gh), method)
			}
			if !slices.Contains(state.Merge.Overridden, WarningReleaseMethod) {
				t.Errorf("the record keeps the confirmation: %v", state.Merge.Overridden)
			}
			if got, _ := m.store.LastMergeMethod(testRepo); got != MergeMethodSquash {
				t.Errorf("a release PR's method is not the repository's next default: %s", got)
			}
		})
	}
}

// A repository without merge commits keeps its own default; merging there still asks first (the sheet points to
// molten release sync-back).
func TestReleasePrWithoutMergeCommits(t *testing.T) {
	t.Parallel()
	SetPostMerge(nil)
	m, dir, _ := releaseMerger(t, molten.ReleasePrSyncBack, onlyMethod(MergeMethodRebase), "")
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Method != MergeMethodRebase || !slices.Equal(plan.Methods, []string{MergeMethodRebase}) {
		t.Fatalf("only rebase is allowed: %s %v", plan.Method, plan.Methods)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err == nil || err.Error() != mergeError(MergeErrConfirm).Error() {
		t.Fatalf("the rebase of a sync-back asks first: %v", err)
	}
}

// Any other PR keeps the remembered method and needs no confirmation (#957 unchanged).
func TestOtherPrKeepsTheRememberedMethod(t *testing.T) {
	t.Parallel()
	SetPostMerge(nil)
	m, dir, _ := releaseMerger(t, "", allAllowed, MergeMethodRebase)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Release != "" || plan.Method != MergeMethodRebase {
		t.Fatalf("a feature PR takes the remembered method: release %q, %s", plan.Release, plan.Method)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
}

func TestReleaseConfirmations(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		plan MergePlan
		want []string
	}{
		{"a merge commit", MergePlan{Release: molten.ReleasePrSyncBack, Method: MergeMethodMerge}, []string{}},
		{"a rebase", MergePlan{Release: molten.ReleasePrRc, Method: MergeMethodRebase, Warnings: []string{CheckIdComments}},
			[]string{CheckIdComments, WarningReleaseMethod}},
		{"a merge queue sets its own method", MergePlan{Release: molten.ReleasePrSyncBack, Method: MergeMethodSquash, Queue: true}, []string{}},
		{"not a release", MergePlan{Method: MergeMethodSquash}, []string{}},
		{"confirmed once", MergePlan{Release: molten.ReleasePrSyncBack, Method: MergeMethodSquash, Warnings: []string{WarningReleaseMethod}},
			[]string{WarningReleaseMethod}},
	}
	for _, c := range cases {
		if got := c.plan.confirmations(); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// The batch modal learns which of its PRs are release pull requests.
func TestMergeMethodsNamesTheReleasePrs(t *testing.T) {
	t.Parallel()
	gh := &fakeGh{views: []fakePr{cleanPr()}, repo: allAllowed}
	m, dir, _ := testMerger(t, gh)
	m.releaseKind = func(dir string, head string, base string) string {
		if head == "main" && base == "develop" {
			return molten.ReleasePrSyncBack
		}
		return ""
	}
	if err := m.store.SetLastMergeMethod(testRepo, MergeMethodRebase); err != nil {
		t.Fatal(err)
	}
	methods, err := m.MergeMethods(context.Background(), MergeMethodsRequest{Dir: dir, Repo: testRepo, Base: "develop",
		Prs: []MergeMethodsPr{{Number: 3, HeadRef: "feature/3-x"}, {Number: 9, HeadRef: "main"}}})
	if err != nil {
		t.Fatal(err)
	}
	if methods.Method != MergeMethodRebase || !slices.Equal(methods.ReleasePrs, []int{9}) {
		t.Fatalf("the modal's method stays the remembered one, #9 is the release PR: %+v", methods)
	}
}

// A sync-back in a group merge merges with a merge commit whatever the modal's method; the others keep it, and the
// remembered method stays.
func TestBatchMergesTheSyncBackWithAMergeCommit(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, nil)
	f.allow(mergeOrRebase)
	f.merger.releaseKind = func(dir string, head string, base string) string {
		if head == f.prs[1].HeadRef {
			return molten.ReleasePrSyncBack
		}
		return ""
	}
	if err := f.merger.store.SetLastMergeMethod(testRepo, MergeMethodRebase); err != nil {
		t.Fatal(err)
	}
	run, err := f.batch("", f.prs[1], f.prs[4])
	if err != nil {
		t.Fatal(err)
	}
	if itemOf(run, 1).Method != MergeMethodMerge || itemOf(run, 4).Method != MergeMethodRebase {
		t.Fatalf("the sync-back joins with a merge commit, the other with the batch's method: %+v", run.Items)
	}
	f.waitEnd()
	if f.hub.methodOf(1) != MergeMethodMerge || f.hub.methodOf(4) != MergeMethodRebase {
		t.Fatalf("merged #1 with %s, #4 with %s", f.hub.methodOf(1), f.hub.methodOf(4))
	}
	if f.last() != MergeMethodRebase {
		t.Errorf("the remembered method stays: %s", f.last())
	}
}
