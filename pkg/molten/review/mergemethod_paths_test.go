// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// #957: every merge path (Validate, Merge several, the queue of validated PRs) uses the repository's remembered
// method by default, saves the developer's choice, and never merges with a method other than the one shown.

const mergeOrRebase = `{"allow_merge_commit":true,"allow_squash_merge":false,"allow_rebase_merge":true}`

func (h *fakeHub) methodOf(number int) string {
	h.lock.Lock()
	defer h.lock.Unlock()
	return h.methods[number]
}

func (f *batchFixture) allow(repo string) {
	f.hub.lock.Lock()
	defer f.hub.lock.Unlock()
	f.hub.repo = repo
}

func (f *batchFixture) last() string {
	f.t.Helper()
	last, err := f.merger.store.LastMergeMethod(testRepo)
	if err != nil {
		f.t.Fatal(err)
	}
	return last
}

func (f *batchFixture) batch(method string, prs ...BatchPr) (BatchRun, error) {
	var order []int
	for _, pr := range prs {
		order = append(order, pr.Number)
	}
	return f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: method, Prs: prs, Source: BatchSourceBatch,
		Order: order, WorkspaceId: "ws"})
}

func TestBatchItemMethod(t *testing.T) {
	plan := MergePlan{Methods: []string{MergeMethodMerge, MergeMethodRebase}, Method: MergeMethodRebase}
	cases := []struct {
		name   string
		item   string
		run    string
		method string
		ok     bool
	}{
		{"the item's own method", MergeMethodMerge, MergeMethodRebase, MergeMethodMerge, true},
		{"the queue's method", "", MergeMethodMerge, MergeMethodMerge, true},
		{"a queue saved before #957 takes the plan's default", "", "", MergeMethodRebase, true},
		{"a method GitHub no longer allows stops the PR", MergeMethodSquash, MergeMethodRebase, MergeMethodSquash, false},
		{"never another method than the queue's", "", MergeMethodSquash, MergeMethodSquash, false},
	}
	for _, c := range cases {
		method, ok := batchItemMethod(BatchItem{BatchPr: BatchPr{Method: c.item}}, BatchRun{Method: c.run}, plan)
		if method != c.method || ok != c.ok {
			t.Errorf("%s: got %s %v, want %s %v", c.name, method, ok, c.method, c.ok)
		}
	}
}

// The DiamondForge case: rebase remembered, a batch whose modal leaves the method to the repository merges with it.
func TestBatchUsesTheRememberedMethod(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.allow(mergeOrRebase)
	if err := f.merger.store.SetLastMergeMethod(testRepo, MergeMethodRebase); err != nil {
		t.Fatal(err)
	}
	run, err := f.batch("", f.prs[1], f.prs[4])
	if err != nil {
		t.Fatal(err)
	}
	if run.Method != MergeMethodRebase || itemOf(run, 1).Method != MergeMethodRebase || itemOf(run, 4).Method != MergeMethodRebase {
		t.Fatalf("the queue takes the remembered method when it joins: %+v", run)
	}
	run = f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{1, 4}) || f.hub.methodOf(1) != MergeMethodRebase || f.hub.methodOf(4) != MergeMethodRebase {
		t.Fatalf("merged %v with %s and %s, state %s", f.hub.merged(), f.hub.methodOf(1), f.hub.methodOf(4), run.State)
	}
	if f.last() != MergeMethodRebase {
		t.Errorf("the remembered method stays: %s", f.last())
	}
}

// The method chosen in the batch modal is the one merged with and the repository's next default; a PR that joined
// earlier keeps the method shown when it joined.
func TestBatchKeepsTheMethodChosenInTheModal(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.allow(mergeOrRebase)
	if _, err := f.batch(MergeMethodRebase, f.prs[1]); err != nil {
		t.Fatal(err)
	}
	if f.last() != MergeMethodRebase {
		t.Fatalf("the modal's choice is kept on start: %q", f.last())
	}
	f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	run, err := f.batch(MergeMethodMerge, f.prs[4])
	if err != nil {
		t.Fatal(err)
	}
	if itemOf(run, 1).Method != MergeMethodRebase || itemOf(run, 4).Method != MergeMethodMerge || f.last() != MergeMethodMerge {
		t.Fatalf("each PR keeps its method, the last choice is the default: %+v, last %s", run.Items, f.last())
	}
	f.setPr(1, func(pr *hubPr) { pr.pendingForever = false })
	f.waitEnd()
	if f.hub.methodOf(1) != MergeMethodRebase || f.hub.methodOf(4) != MergeMethodMerge {
		t.Fatalf("merged #1 with %s, #4 with %s", f.hub.methodOf(1), f.hub.methodOf(4))
	}
}

func TestBatchRefusesAMethodTheRepositoryDoesNotAllow(t *testing.T) {
	f := newBatchFixture(t, nil)
	if _, err := f.batch(MergeMethodRebase, f.prs[1]); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("a modal method GitHub refuses does not start: %v", err)
	}
	if f.last() != "" {
		t.Errorf("a refused method is not kept: %s", f.last())
	}
}

// A PR whose method GitHub no longer allows when its turn comes stops; it never merges with another method.
func TestBatchStopsRatherThanMergeWithAnotherMethod(t *testing.T) {
	f := newBatchFixture(t, nil)
	pr := f.prs[1]
	pr.Method = MergeMethodSquash
	if _, err := f.batch("", pr); err != nil {
		t.Fatal(err)
	}
	run := f.waitEnd()
	one := itemOf(run, 1)
	if len(f.hub.merged()) != 0 || one.Reason != BatchReasonMethod || !slices.Equal(one.Names, []string{MergeMethodSquash}) {
		t.Fatalf("merged %v, item %+v", f.hub.merged(), one)
	}
}

// Validate while CI runs: the method of the sheet is kept as the default when the PR joins, and merged with.
func TestQueueValidateKeepsTheMethodOfTheSheet(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.allow(mergeOrRebase)
	plan, err := f.merger.Plan(context.Background(), MergePlanRequest{PrKey: PrKey{Repo: testRepo, Number: 1}, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Method != MergeMethodMerge || plan.MethodRefused != "" {
		t.Fatalf("GitHub's order without a remembered method: %s %q", plan.Method, plan.MethodRefused)
	}
	pr := f.prs[1]
	pr.PlanId, pr.Method = plan.Id, MergeMethodRebase
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Prs: []BatchPr{pr}, WorkspaceId: "ws"}); err != nil {
		t.Fatal(err)
	}
	if f.last() != MergeMethodRebase {
		t.Fatalf("the sheet's method is the default once validated: %q", f.last())
	}
	f.setPr(1, func(pr *hubPr) { pr.pendingForever = false })
	f.waitEnd()
	if f.hub.methodOf(1) != MergeMethodRebase {
		t.Fatalf("merged with %s", f.hub.methodOf(1))
	}
}

// Validate: the merged method is the one shown, a refused remembered method is announced, and GitHub refusing the
// method has its own outcome.
func TestValidateMergesWithTheMethodShown(t *testing.T) {
	SetPostMerge(nil)
	gh := &fakeGh{views: []fakePr{cleanPr()}, repo: onlyMethod(MergeMethodMerge)}
	m, dir, _ := testMerger(t, gh)
	if err := m.store.SetLastMergeMethod(testRepo, MergeMethodRebase); err != nil {
		t.Fatal(err)
	}
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Method != MergeMethodMerge || plan.MethodRefused != MergeMethodRebase {
		t.Fatalf("a remembered method GitHub refuses is announced: %s, refused %q", plan.Method, plan.MethodRefused)
	}
	methods, err := m.MergeMethods(context.Background(), MergeMethodsRequest{Dir: dir, Repo: testRepo, Base: "develop"})
	if err != nil || methods.Method != MergeMethodMerge || methods.MethodRefused != MergeMethodRebase || !slices.Equal(methods.Methods, []string{MergeMethodMerge}) {
		t.Fatalf("the batch modal reads the same: %+v %v", methods, err)
	}
	shown := plan.Method
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: shown}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge.Method != shown || !strings.Contains(mergeCall(t, gh), " --"+shown+" ") {
		t.Fatalf("merged with %s (%s), shown %s", state.Merge.Method, mergeCall(t, gh), shown)
	}
	if last, _ := m.store.LastMergeMethod(testRepo); last != shown {
		t.Errorf("the method merged with is the next default: %s", last)
	}
}

func TestMethodRefusedByGithub(t *testing.T) {
	for _, msg := range []string{"GraphQL: Rebase merges are not allowed on this repository (mergePullRequest)", "Merge method is not allowed"} {
		if !methodRefusedError(errorString(msg)) {
			t.Errorf("not seen as a method refusal: %s", msg)
		}
	}
	if methodRefusedError(errorString("Pull request is not mergeable")) {
		t.Errorf("a conflict is not a method refusal")
	}
}

type errorString string

func (e errorString) Error() string {
	return string(e)
}
