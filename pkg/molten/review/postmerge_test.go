// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"strings"
	"testing"
)

// postMergeService is wavesrv's review Service installed as the post-merge hook (Start), its merge on a fake gh and
// its cleanup on the cleanup fixture (a local bare remote and a fake gh).
func postMergeService(t *testing.T, f *cleanupFixture, gh *fakeGh) *Service {
	t.Helper()
	s := MakeService(f.dataDir, nil, nil)
	s.cleaner = f.cleaner()
	s.merger = MakeMerger(s.store, gh.run, nil)
	s.merger.pollEvery = 0
	SetPostMerge(s)
	t.Cleanup(func() { SetPostMerge(nil) })
	return s
}

func (f *cleanupFixture) cleanupRuns() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	runs := 0
	for _, call := range f.ghCalls {
		if strings.HasPrefix(strings.Join(call, " "), "pr view 7 --json state,headRefName") {
			runs++
		}
	}
	return runs
}

func TestValidateRunsTheCleanupOnce(t *testing.T) {
	f := makeCleanupFixture(t, false)
	merged := cleanPr()
	merged.State = "MERGED"
	merged.MergeOid = oidC
	s := postMergeService(t, f, &fakeGh{views: []fakePr{cleanPr(), cleanPr(), merged}})
	if currentPostMerge() != PostMerge(s) {
		t.Fatalf("the service is the post-merge hook")
	}
	plan, err := s.merger.Plan(context.Background(), MergePlanRequest{PrKey: testKey, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Cleanup) != len(CleanupSteps) || plan.Cleanup[1].Id != CleanupStepTicketClose || plan.Cleanup[1].Message != "#590" {
		t.Fatalf("the plan lists the cleanup's steps: %+v", plan.Cleanup)
	}
	for _, step := range plan.Cleanup {
		if step.State != CleanupStatePlanned {
			t.Errorf("planned step: %+v", step)
		}
	}
	if f.cleanupRuns() != 0 {
		t.Fatalf("the plan runs nothing")
	}
	if _, err := s.merger.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	s.merger.wait(testKey)
	if runs := f.cleanupRuns(); runs != 1 {
		t.Fatalf("the cleanup runs once after the merge: %d", runs)
	}
	state, _ := s.store.Get(testKey)
	if state.Merge == nil || state.Merge.State != MergeMerged || state.Merge.CleanupRunning {
		t.Fatalf("merge record: %+v", state.Merge)
	}
	if state.Cleanup == nil || state.Cleanup.Ticket != 590 || state.Cleanup.StartAt < state.Merge.StartedAt {
		t.Fatalf("the cleanup's outcome is in the store: %+v", state.Cleanup)
	}
	expectStep(t, *state.Cleanup, CleanupStepPr, CleanupStateDone)
	expectStep(t, *state.Cleanup, CleanupStepTicketClose, CleanupStateDone)
	expectStep(t, *state.Cleanup, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, *state.Cleanup, CleanupStepLocalBranch, CleanupStateDone)
}

func TestRefusedMergeRunsNoCleanup(t *testing.T) {
	f := makeCleanupFixture(t, false)
	pushed := cleanPr()
	pushed.Head = oidB
	s := postMergeService(t, f, &fakeGh{views: []fakePr{cleanPr(), pushed}})
	plan, err := s.merger.Plan(context.Background(), MergePlanRequest{PrKey: testKey, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.merger.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	s.merger.wait(testKey)
	state, _ := s.store.Get(testKey)
	if state.Merge == nil || state.Merge.State != MergeRefused {
		t.Fatalf("refused: %+v", state.Merge)
	}
	if f.cleanupRuns() != 0 || state.Cleanup != nil || !exists(f.agent) {
		t.Errorf("no cleanup after a refused merge: %d %+v", f.cleanupRuns(), state.Cleanup)
	}
}
