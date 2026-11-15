// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// #2318: a group merge that runs cannot be started a second time, from any window; Cancel stops it after the current
// step, never in the middle of a merge or a push, and the project accepts a group merge again once it stopped.

// groupAdd is "Merge these N in this order" from a window: the PRs as listed, source batch.
func (f *batchFixture) groupAdd(numbers ...int) (BatchRun, error) {
	f.t.Helper()
	var prs []BatchPr
	for _, n := range numbers {
		prs = append(prs, f.prs[n])
	}
	return f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: "merge", Prs: prs, Source: BatchSourceBatch,
		Order: numbers, WorkspaceId: "ws"})
}

func groupRefusal(t *testing.T, err error) *uimsg.Text {
	t.Helper()
	if err == nil {
		t.Fatalf("the second group merge should be refused")
	}
	text := uimsg.TextOf(err)
	if text == nil || text.Code != "review.batchgroup" || text.Vars["base"] != "develop" {
		t.Fatalf("the refusal should say a group merge runs into develop: %v (%+v)", err, text)
	}
	return text
}

func itemNumbers(run BatchRun) []int {
	var rtn []int
	for _, it := range run.Items {
		rtn = append(rtn, it.Number)
	}
	return rtn
}

// AC3 (server): the second start is refused with a stated reason, whether it names the same PRs or others, and the run
// the first one made is left as it was.
func TestBatchRefusesASecondGroupMergeWhileOneRuns(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	first := f.start(1, 4)
	f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	for _, numbers := range [][]int{{1, 4}, {4}, {2, 3}, {4, 2}} {
		_, err := f.groupAdd(numbers...)
		groupRefusal(t, err)
	}
	run := f.get()
	if run.Id != first.Id || !slices.Equal(itemNumbers(run), []int{1, 4}) || run.State != BatchRunning {
		t.Fatalf("the refused starts leave the run as it was: %+v", run)
	}
	if got := f.hub.merged(); len(got) != 0 {
		t.Fatalf("nothing merged by a refused start: %v", got)
	}
}

// Every window asks the same run: what one starts, the other reads running, and its own start is refused.
func TestBatchGroupStateIsTheRunsForEveryReader(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.start(1, 4)
	read, err := f.runner.Get(BatchRequest{Dir: f.dir, Base: "develop"})
	if err != nil || read == nil || !read.groupRunning() {
		t.Fatalf("another window reads the group merge as running: %+v, %v", read, err)
	}
	_, err = f.runner.Add(QueueAddRequest{Dir: f.dir + "/", Repo: testRepo, Base: "develop", Method: "merge", Prs: []BatchPr{f.prs[2]},
		Source: BatchSourceBatch, WorkspaceId: "other-ws"})
	groupRefusal(t, err)
}

// A queue of validated PRs is not a group merge: a PR validated later still joins it (FR-REV-026 AC2), and a group merge
// may join a queue of validated PRs.
func TestBatchGroupRefusalLeavesValidatedQueuesAlone(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Prs: []BatchPr{f.prs[1]}, WorkspaceId: "ws"}); err != nil {
		t.Fatal(err)
	}
	run, err := f.groupAdd(2, 3)
	if err != nil || !slices.Equal(sortedNumbers(run), []int{1, 2, 3}) {
		t.Fatalf("a group merge joins a queue of validated PRs: %+v, %v", run, err)
	}
	joined, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{f.prs[4]}})
	if err != nil || joined.Id != run.Id || len(joined.Items) != 4 {
		t.Fatalf("a PR validated later still joins the queue: %+v, %v", joined, err)
	}
}

func sortedNumbers(run BatchRun) []int {
	rtn := itemNumbers(run)
	slices.Sort(rtn)
	return rtn
}

// The PR the run stopped on keeps Try again: it goes back in its own run, whose other PRs are left as they are.
func TestBatchGroupRefusalAllowsTryAgainOnAStoppedPr(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.agent.ambiguous[5] = true
	first := f.start(2, 5, 1)
	f.waitFor("#5 stopped, #1 waiting for its checks", func(run BatchRun) bool {
		return itemOf(run, 5).State == BatchItemStopped && itemOf(run, 1).State == BatchItemWaitingChecks
	})
	_, err := f.groupAdd(3)
	groupRefusal(t, err)
	_, err = f.groupAdd(5, 3)
	groupRefusal(t, err)
	retry := f.prs[5]
	retry.HeadOid = itemOf(f.get(), 5).Valid
	run, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: "merge", Prs: []BatchPr{retry},
		Source: BatchSourceBatch, Order: []int{5}, WorkspaceId: "ws"})
	if err != nil || run.Id != first.Id {
		t.Fatalf("Try again on the stopped PR joins its own run: %+v, %v", run, err)
	}
	if five := itemOf(run, 5); five.State != BatchItemQueued || !slices.Equal(itemNumbers(run), []int{2, 5, 1}) {
		t.Fatalf("#5 back in its place, nothing else changed: %+v", run)
	}
}

// Cancel brings the project back to a free state: once the run stopped, a group merge starts again.
func TestBatchGroupMergeStartsAgainOnceCancelled(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	first := f.start(1, 4)
	f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	if _, err := f.runner.Cancel(BatchRequest{Dir: f.dir, Base: "develop", Id: first.Id}); err != nil {
		t.Fatal(err)
	}
	if run := f.waitEnd(); run.State != BatchCancelled || run.groupRunning() {
		t.Fatalf("the cancelled run no longer runs: %+v", run)
	}
	run, err := f.groupAdd(4)
	if err != nil || run.Id == first.Id {
		t.Fatalf("a group merge starts again once the first stopped: %+v, %v", run, err)
	}
	end := f.waitEnd()
	if end.State != BatchDone || !slices.Equal(f.hub.merged(), []int{4}) {
		t.Fatalf("the new group merge merges #4: %+v, merged %v", end, f.hub.merged())
	}
}

func TestGroupRunningAndTheRefusal(t *testing.T) {
	t.Parallel()
	item := func(number int, source string, state string) BatchItem {
		return BatchItem{BatchPr: BatchPr{Number: number}, Source: source, State: state}
	}
	run := func(state string, cancel bool, items ...BatchItem) BatchRun {
		return BatchRun{State: state, CancelAsked: cancel, Items: items}
	}
	group := QueueAddRequest{Source: BatchSourceBatch, Prs: []BatchPr{{Number: 9}}}
	retry := QueueAddRequest{Source: BatchSourceBatch, Prs: []BatchPr{{Number: 2}}}
	validated := QueueAddRequest{Prs: []BatchPr{{Number: 9}}}
	tests := []struct {
		name    string
		run     BatchRun
		running bool
		refuses bool
		req     QueueAddRequest
	}{
		{"a group merge waiting its turn", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemQueued)), true, true, group},
		{"a group merge in progress", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemMerging)), true, true, group},
		{"waiting for its checks", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemWaitingChecks)), true, true, group},
		{"being cancelled has its own refusal", run(BatchCancelling, true, item(1, BatchSourceBatch, BatchItemWaitingChecks)), true, false, group},
		{"cancelled", run(BatchCancelled, true, item(1, BatchSourceBatch, BatchItemWithdrawn)), false, false, group},
		{"done", run(BatchDone, false, item(1, BatchSourceBatch, BatchItemMerged)), false, false, group},
		{"only validated PRs", run(BatchRunning, false, item(1, BatchSourceValidate, BatchItemWaitingChecks)), false, false, group},
		{"a PR set aside on a failing check waits for the developer", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemFailed)), false, false, group},
		{"every group PR ended, a validated one still waits", run(BatchRunning, false,
			item(1, BatchSourceBatch, BatchItemMerged), item(2, BatchSourceValidate, BatchItemWaitingChecks)), false, false, group},
		{"a validation is not a group merge", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemQueued)), true, false, validated},
		{"Try again on a stopped PR", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemQueued),
			item(2, BatchSourceBatch, BatchItemStopped)), true, false, retry},
		{"Try again on a PR set aside on a failing check", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemQueued),
			item(2, BatchSourceBatch, BatchItemFailed)), true, false, retry},
		{"a PR still in the run is not a retry", run(BatchRunning, false, item(1, BatchSourceBatch, BatchItemQueued),
			item(2, BatchSourceBatch, BatchItemWaitingChecks)), true, true, retry},
	}
	for _, tc := range tests {
		if got := tc.run.groupRunning(); got != tc.running {
			t.Errorf("%s: groupRunning %v, want %v", tc.name, got, tc.running)
		}
		if got := refusesSecondGroup(tc.run, tc.req); got != tc.refuses {
			t.Errorf("%s: refuses %v, want %v", tc.name, got, tc.refuses)
		}
	}
}

// Cancel stops after the current step: a rebase the agent is still doing, and its push, finish first; nothing more is
// merged. The agent is held at the start of its brief; the run is seen waiting for it through several of its looks
// after the Cancel (its own waits are counted, no clock), then the agent is let go.
func TestBatchCancelWaitsForTheAgentsPushAndMergesNothingMore(t *testing.T) {
	t.Parallel()
	f := newBatchFixture(t, nil)
	f.agent.hold = make(chan struct{})
	f.agent.holding = make(chan struct{}, 1)
	var release sync.Once
	releaseAgent := func() { release.Do(func() { close(f.agent.hold) }) }
	t.Cleanup(releaseAgent)
	var looks atomic.Int64
	f.runner.env.Sleep = func(ctx context.Context, d time.Duration) bool {
		if d == f.runner.env.AgentEvery {
			looks.Add(1)
		}
		return sleepCtx(ctx, d)
	}
	before := f.hub.mustGit("rev-parse", "refs/heads/feature/3-three")
	first := f.start(2, 3, 4)
	select {
	case <-f.agent.holding:
	case <-time.After(batchTestWait):
		t.Fatalf("the agent never got #3 to rebase")
	}
	if _, err := f.runner.Cancel(BatchRequest{Dir: f.dir, Base: "develop", Id: first.Id}); err != nil {
		t.Fatal(err)
	}
	asked := looks.Load()
	deadline := time.Now().Add(batchTestWait)
	for looks.Load() < asked+3 {
		if time.Now().After(deadline) {
			t.Fatalf("the run never looked at its agent again")
		}
		time.Sleep(time.Millisecond)
	}
	if run := f.get(); run.State != BatchCancelling || itemOf(run, 3).State != BatchItemRebasing || !run.groupRunning() {
		t.Fatalf("Cancel waits for the step under way: %+v", run)
	}
	releaseAgent()
	run := f.waitEnd()
	if run.State != BatchCancelled {
		t.Fatalf("state %s, want cancelled", run.State)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2}) {
		t.Fatalf("merged %v, want only #2, merged before the Cancel", got)
	}
	if after := f.hub.mustGit("rev-parse", "refs/heads/feature/3-three"); after == before {
		t.Fatalf("the agent's push finished before the run stopped")
	}
	for _, n := range []int{3, 4} {
		if it := itemOf(run, n); it.State != BatchItemWithdrawn || it.Reason != BatchReasonCancelled {
			t.Fatalf("#%d: %+v", n, it)
		}
	}
}
