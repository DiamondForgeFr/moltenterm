// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeClock: the merger's clock, moved only by its sleeps (no wall clock in the tests).
type fakeClock struct {
	lock sync.Mutex
	at   time.Time
}

func (c *fakeClock) now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.at
}

func (c *fakeClock) sleep(ctx context.Context, d time.Duration) bool {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.at = c.at.Add(d)
	return ctx.Err() == nil
}

// fakeLocalCi: what the local CI says of the project; asked records the heads GreenOn was asked about.
type fakeLocalCi struct {
	lock  sync.Mutex
	busy  bool
	green bool
	asked []string
}

func (f *fakeLocalCi) greenOn(dir string, sha string) bool {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.asked = append(f.asked, sha)
	return f.green
}

func (f *fakeLocalCi) isBusy(dir string) bool {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.busy
}

func repeatPr(pr fakePr, n int) []fakePr {
	rtn := make([]fakePr, n)
	for i := range rtn {
		rtn[i] = pr
	}
	return rtn
}

// localStarted: the local CI's local-tests status, posted once its job runs.
func localStarted() fakePr {
	pr := cleanPr()
	pr.Head = oidB
	pr.Checks = append(green("build"), map[string]string{"context": "local-tests", "state": "PENDING", "startedAt": "2026-11-09T10:00:00Z"})
	return pr
}

// localMissing: GitHub rebased the branch and its own check passed; no local-tests status on the new head yet.
func localMissing() fakePr {
	pr := cleanPr()
	pr.Head = oidB
	pr.Checks = green("build")
	return pr
}

func mergedOnB() fakePr {
	pr := cleanPr()
	pr.Head = oidB
	return pr
}

// mergeAfterUpdate runs a merge whose branch GitHub updates first, then reads after reads on the new head, one per
// minute of the fake clock; it returns the record and how long the CI wait took.
func mergeAfterUpdate(t *testing.T, local *fakeLocalCi, after []fakePr) (MergeRecord, time.Duration) {
	t.Helper()
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	gh := &fakeGh{views: []fakePr{behind, behind, behind}}
	gh.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			g.views = append(g.views[:g.viewed], after...)
		}
	}
	m, dir, _ := testMerger(t, gh)
	clock := &fakeClock{at: time.Now()}
	m.now, m.sleep, m.pollEvery = clock.now, clock.sleep, time.Minute
	if local != nil {
		m.localGreen, m.localBusy = local.greenOn, local.isBusy
	}
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	start := clock.now()
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, err := m.store.Get(testKey)
	if err != nil || state.Merge == nil {
		t.Fatalf("no merge record: %v", err)
	}
	return *state.Merge, clock.now().Sub(start)
}

// AC-3: an hour while the local CI is busy with another run, then ten minutes of run, merges: only the run counts
// against the 45 minutes.
func TestMergeCiWaitSkipsTheTimeChecksWaitToStart(t *testing.T) {
	t.Parallel()
	after := append(repeatPr(localMissing(), 60), repeatPr(localStarted(), 10)...)
	record, _ := mergeAfterUpdate(t, &fakeLocalCi{busy: true}, append(after, mergedOnB()))
	if record.State != MergeMerged || record.Head != oidB {
		t.Fatalf("merged once the checks passed: %+v", record)
	}
}

// A queued GitHub job (pending, no start time) does not count either.
func TestMergeCiWaitSkipsQueuedJobs(t *testing.T) {
	t.Parallel()
	queued := localStarted()
	queued.Checks = append(green("local-tests"), map[string]string{"name": "build", "status": "QUEUED"})
	record, _ := mergeAfterUpdate(t, nil, append(repeatPr(queued, 60), mergedOnB()))
	if record.State != MergeMerged {
		t.Fatalf("merged after the queued job ran: %+v", record)
	}
}

// Running checks still count: 50 minutes of run stops the merge at 45.
func TestMergeCiWaitStillTimesOutOnRunningChecks(t *testing.T) {
	t.Parallel()
	record, took := mergeAfterUpdate(t, nil, repeatPr(localStarted(), 200))
	if record.State != MergeFailed || record.Code != MergeCodeCiTimeout {
		t.Fatalf("CI timeout: %+v", record)
	}
	if took > defaultCiTimeout+5*time.Minute {
		t.Errorf("stopped after %v, want about %v", took, defaultCiTimeout)
	}
}

// A check that never starts while the local CI stays busy still stops the merge, once the queued time ran out too.
func TestMergeCiWaitBoundsTheQueuedTime(t *testing.T) {
	t.Parallel()
	record, took := mergeAfterUpdate(t, &fakeLocalCi{busy: true}, []fakePr{localMissing()})
	if record.State != MergeFailed || record.Code != MergeCodeCiTimeout {
		t.Fatalf("CI timeout: %+v", record)
	}
	if took < defaultCiTimeout+maxCiQueued || took > defaultCiTimeout+maxCiQueued+5*time.Minute {
		t.Errorf("stopped after %v, want about %v", took, defaultCiTimeout+maxCiQueued)
	}
}

// A local status missing while nothing runs locally will not come by waiting: the 45 minutes count as usual.
func TestMergeCiWaitCountsAMissingLocalStatusWhenNothingRuns(t *testing.T) {
	t.Parallel()
	record, took := mergeAfterUpdate(t, &fakeLocalCi{}, []fakePr{localMissing()})
	if record.State != MergeFailed || record.Code != MergeCodeCiTimeout {
		t.Fatalf("CI timeout: %+v", record)
	}
	if took > defaultCiTimeout+5*time.Minute {
		t.Errorf("stopped after %v, want about %v", took, defaultCiTimeout)
	}
}

// The coordinator's case (#2141): every GitHub check green on the rebased head, the local CI already green on its code
// (tested before the push, its statuses never reached GitHub): the merge goes on at once instead of timing out.
func TestMergeCiWaitAcceptsTheLocalVerdictOnTheSameCode(t *testing.T) {
	t.Parallel()
	local := &fakeLocalCi{green: true}
	record, took := mergeAfterUpdate(t, local, []fakePr{localMissing()})
	if record.State != MergeMerged || record.Head != oidB {
		t.Fatalf("merged on the local verdict: %+v", record)
	}
	if took > 10*time.Minute {
		t.Errorf("waited %v for statuses the local CI had already answered", took)
	}
	local.lock.Lock()
	defer local.lock.Unlock()
	if len(local.asked) != 1 || local.asked[0] != oidB {
		t.Errorf("asked the local CI once about the new head: %v", local.asked)
	}
}
