// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"testing"
	"time"
)

// #2141: Cancel on the queue ends Validate's CI wait at once, not at the next look for the merge's end (AgentEvery is
// an hour here, so a wait that needs that look shows as a hang).
func TestBatchCancelEndsTheCiWaitAtOnce(t *testing.T) {
	t.Parallel()
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	gh := &fakeGh{views: []fakePr{behind, behind, behind}}
	gh.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			g.views = append(g.views[:g.viewed], localStarted())
		}
	}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Minute)
	for {
		state, _ := m.store.Get(testKey)
		if state.Merge != nil && state.Merge.State == MergeWaitingCi {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the merge never waited for CI: %+v", state.Merge)
		}
		time.Sleep(5 * time.Millisecond)
	}
	b := MakeBatchRunner(BatchEnv{Merger: m, DataDir: t.TempDir(), AgentEvery: time.Hour})
	ctl := &batchCtl{run: BatchRun{CancelAsked: true}, withdrawn: map[int]bool{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ended := make(chan MergeRecord, 1)
	go func() { ended <- b.waitMerge(ctx, ctl, testKey) }()
	select {
	case record := <-ended:
		if record.State != MergeCancelled {
			t.Fatalf("the CI wait is cancelled: %+v", record)
		}
	case <-time.After(time.Minute):
		t.Fatalf("Cancel did not end the CI wait")
	}
	if len(gh.writes()) != 1 {
		t.Errorf("only GitHub's update, never a merge: %v", gh.writes())
	}
}
