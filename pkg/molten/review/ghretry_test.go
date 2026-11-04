// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

const gh502 = "gh pr merge 7 --rebase --match-head-commit aaaaaaa: non-200 OK status code: 502 Bad Gateway body: \"\""

func TestGhTransient(t *testing.T) {
	cases := []struct {
		text      string
		status    int
		transient bool
	}{
		{gh502, 502, true},
		{"HTTP 503: Service Unavailable (https://api.github.com/graphql)", 503, true},
		{"504 Gateway Timeout", 504, true},
		{"Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host", 0, true},
		{"Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout", 0, true},
		{"read tcp 10.0.0.2:5555->140.82.112.6:443: read: connection reset by peer", 0, true},
		{"GraphQL: Something went wrong while executing your query. Please include `ABC` when reporting this issue.", 0, true},
		{"HTTP 404: Not Found (https://api.github.com/repos/owner/name)", 404, false},
		{"HTTP 409: Conflict, request timeout", 409, false},
		{"GraphQL: Head branch was modified. Review and try the merge again.", 0, false},
		{"GraphQL: Pull Request is not mergeable (mergePullRequest)", 0, false},
		{"GraphQL: Required status check \"ci\" is expected.", 0, false},
	}
	for _, tc := range cases {
		status, transient := ghTransient(tc.text)
		if status != tc.status || transient != tc.transient {
			t.Errorf("%q: got %d %v, want %d %v", tc.text, status, transient, tc.status, tc.transient)
		}
	}
}

// fakeSleeps records the waits asked and returns at once (no wall clock in the tests).
type fakeSleeps struct {
	lock  sync.Mutex
	waits []time.Duration
}

func (s *fakeSleeps) sleep(ctx context.Context, d time.Duration) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.waits = append(s.waits, d)
	return ctx.Err() == nil
}

func (s *fakeSleeps) asked() []time.Duration {
	s.lock.Lock()
	defer s.lock.Unlock()
	return append([]time.Duration(nil), s.waits...)
}

// mergeErrors makes gh pr merge answer errs in turn (nil: GitHub merges), the last one repeating.
func mergeErrors(gh *fakeGh, errs ...error) {
	tries := 0
	gh.onCall = func(g *fakeGh, args []string) {
		if args[0] != "pr" || args[1] != "merge" {
			return
		}
		g.mergeErr = errs[min(tries, len(errs)-1)]
		tries++
	}
}

func mergeCalls(gh *fakeGh) int {
	n := 0
	for _, w := range gh.writes() {
		if w[0] == "pr" && w[1] == "merge" {
			n++
		}
	}
	return n
}

func runMerge(t *testing.T, gh *fakeGh) (MergeRecord, *fakeSleeps) {
	t.Helper()
	SetPostMerge(nil)
	m, dir, _ := testMerger(t, gh)
	sleeps := &fakeSleeps{}
	m.sleep = sleeps.sleep
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, err := m.store.Get(testKey)
	if err != nil || state.Merge == nil {
		t.Fatalf("no merge record: %v", err)
	}
	return *state.Merge, sleeps
}

func TestMergeRetriesA502ThenMerges(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	mergeErrors(gh, errors.New(gh502), nil)
	record, sleeps := runMerge(t, gh)
	if record.State != MergeMerged || record.Code != MergeCodeMerged {
		t.Fatalf("merged after the 502: %+v", record)
	}
	if got := mergeCalls(gh); got != 2 {
		t.Fatalf("%d merge calls, want 2", got)
	}
	if got := sleeps.asked(); !slices.Equal(got, ghRetryDelays[:1]) {
		t.Fatalf("waits %v, want %v", got, ghRetryDelays[:1])
	}
}

func TestMergeStopsAfterTheTriesWhenGithubStaysDown(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	mergeErrors(gh, errors.New(gh502))
	record, sleeps := runMerge(t, gh)
	if record.State != MergeFailed || record.Code != MergeCodeUnavailable || record.Status != 502 {
		t.Fatalf("stopped as GitHub not answering: %+v", record)
	}
	if got := mergeCalls(gh); got != len(ghRetryDelays)+1 {
		t.Fatalf("%d merge calls, want %d", got, len(ghRetryDelays)+1)
	}
	if got := sleeps.asked(); !slices.Equal(got, ghRetryDelays) {
		t.Fatalf("waits %v, want %v", got, ghRetryDelays)
	}
}

func TestMergeA4xxIsNotRetried(t *testing.T) {
	for _, text := range []string{"HTTP 409: Conflict (mergePullRequest)", "GraphQL: Pull Request is not mergeable (mergePullRequest)"} {
		gh := &fakeGh{views: []fakePr{cleanPr()}}
		mergeErrors(gh, errors.New(text))
		record, sleeps := runMerge(t, gh)
		if record.State != MergeFailed || record.Code != MergeCodeMergeError {
			t.Fatalf("%s: failed as a merge error: %+v", text, record)
		}
		if got := mergeCalls(gh); got != 1 || len(sleeps.asked()) != 0 {
			t.Fatalf("%s: %d merge calls, waits %v: never tried again", text, got, sleeps.asked())
		}
	}
}

// A 502 that came back although GitHub merged: the PR reads merged, so the merge is not sent again.
func TestMergeA502AfterGithubMergedIsNotSentAgain(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	tries := 0
	gh.onCall = func(g *fakeGh, args []string) {
		if args[0] != "pr" || args[1] != "merge" {
			return
		}
		tries++
		g.mergeErr = nil
		g.mergeNow()
		g.mergeErr = errors.New(gh502)
	}
	record, _ := runMerge(t, gh)
	if record.State != MergeMerged {
		t.Fatalf("merged: %+v", record)
	}
	if tries != 1 {
		t.Fatalf("%d merge calls, want 1", tries)
	}
}

// The queue: a PR GitHub does not merge (502 on every try) stops as GitHub not answering while the next one merges;
// tried again alone once GitHub is back, it merges.
func TestQueueStopsOnAnOutageAndMergesWhenTriedAgain(t *testing.T) {
	f := newBatchFixture(t, nil)
	sleeps := &fakeSleeps{}
	f.merger.sleep = sleeps.sleep
	f.hub.lock.Lock()
	f.hub.down = map[int]error{1: errors.New(gh502)}
	f.hub.lock.Unlock()
	f.start(1, 4)
	run := f.waitEnd()
	one := itemOf(run, 1)
	if one.State != BatchItemStopped || one.Reason != BatchReasonUnavailable || one.Status != 502 {
		t.Fatalf("#1 stopped as GitHub not answering: %+v", one)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{4}) {
		t.Fatalf("merged %v, want only 4", got)
	}
	if got := sleeps.asked(); !slices.Equal(got, ghRetryDelays) {
		t.Fatalf("waits %v, want the tries again %v", got, ghRetryDelays)
	}
	stop := f.notices.find("stop:")
	if stop == nil || stop.MessageText == nil || stop.MessageText.Parts["reason"].Code != "notif.review.batch.why.unavailable" {
		t.Fatalf("the stop notification says GitHub did not answer: %+v", stop)
	}
	f.hub.lock.Lock()
	f.hub.down = nil
	f.hub.lock.Unlock()
	retry := f.prs[1]
	retry.HeadOid = one.Valid
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: "merge", Prs: []BatchPr{retry},
		Source: BatchSourceBatch, Order: []int{1}, WorkspaceId: "ws"}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if one := itemOf(run, 1); one.State != BatchItemMerged || len(run.Items) != 1 {
		t.Fatalf("#1 alone merged once tried again: %+v", run)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{4, 1}) {
		t.Fatalf("merged %v, want 4 then 1", got)
	}
}

func TestBatchStopOnGithubNotAnswering(t *testing.T) {
	stop := unavailableStop(batchStop{reason: BatchReasonMergeFailed, code: MergeCodeUnavailable, status: 502, detail: gh502})
	if stop.reason != BatchReasonUnavailable || stop.status != 502 {
		t.Fatalf("merge record unavailable: %+v", stop)
	}
	stop = unavailableStop(batchStop{reason: BatchReasonRead, detail: "HTTP 503: Service Unavailable"})
	if stop.reason != BatchReasonUnavailable || stop.status != 503 {
		t.Fatalf("read on a 503: %+v", stop)
	}
	stop = unavailableStop(batchStop{reason: BatchReasonMergeFailed, code: MergeCodeMergeError, detail: "HTTP 422: Unprocessable"})
	if stop.reason != BatchReasonMergeFailed {
		t.Fatalf("a 4xx stays a merge failure: %+v", stop)
	}
	_, text := batchReasonText(BatchItem{Reason: BatchReasonUnavailable, Status: 502}, "develop")
	if text.Code != "notif.review.batch.why.unavailable" || text.Vars["status"] != "502" {
		t.Fatalf("notification text: %+v", text)
	}
	_, text = batchReasonText(BatchItem{Reason: BatchReasonUnavailable}, "develop")
	if text.Code != "notif.review.batch.why.unavailableNoStatus" {
		t.Fatalf("notification text without status: %+v", text)
	}
}
