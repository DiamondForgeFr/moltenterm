// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// A push refreshes its PR at once (#2145, FR-REV-022 AC22): the list showed "Conflicts with develop" and a red CI for a
// head that was rebased and pushed minutes before.

const (
	pushedOldHead = "751c0f8e0000000000000000000000000000aaaa"
	pushedNewHead = "02d4ec6760000000000000000000000000000bbbb"
)

const pushedRedRollup = `[{"name":"Backend","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-09T16:00:00Z"}]`
const pushedRunningRollup = `[{"name":"Backend","workflowName":"CI","status":"IN_PROGRESS","startedAt":"2026-11-09T16:15:30Z"}]`

func pushedPr(head string, mergeable string, mergeState string, rollup string, state string) string {
	return fmt.Sprintf(`{"number":9,"title":"Fix x","url":"https://github.com/acme/app/pull/9","headRefName":"fix/9-x","baseRefName":"develop","headRefOid":%q,"isDraft":false,"updatedAt":"2026-11-09T16:00:00Z","mergeable":%q,"mergeStateStatus":%q,"statusCheckRollup":%s,"state":%q}`,
		head, mergeable, mergeState, rollup, state)
}

// pushGh is GitHub and the repository around one PR: the list shows the head the PR had before the push, a read of the
// PR on its own shows the pushed one, with its mergeability still unknown for a few reads.
type pushGh struct {
	lock sync.Mutex
	// tip: where fix/9-x is on origin as the repository knows it.
	tip string
	// pushed: the PR as a read of it shows it after the push.
	unknownReads int
	state        string
	views        int
	lists        int
}

func (g *pushGh) run(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
	g.lock.Lock()
	defer g.lock.Unlock()
	switch {
	case name == "git" && args[0] == "for-each-ref" && args[len(args)-1] == "refs/remotes/origin":
		return []byte(g.tip + " fix/9-x\n" + pushedOldHead + " main\n"), nil
	case name != "gh":
		return nil, errors.New("no git here")
	case args[0] == "repo":
		return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
	case args[0] == "pr" && args[1] == "list" && strings.Contains(strings.Join(args, " "), "--state open"):
		g.lists++
		return []byte("[" + pushedPr(pushedOldHead, "CONFLICTING", "DIRTY", pushedRedRollup, "OPEN") + "]"), nil
	case args[0] == "pr" && args[1] == "view":
		g.views++
		if g.state != "OPEN" {
			return []byte(pushedPr(g.tip, "MERGEABLE", "CLEAN", pushedRunningRollup, g.state)), nil
		}
		if g.views <= g.unknownReads {
			return []byte(pushedPr(g.tip, "UNKNOWN", "UNKNOWN", "[]", "OPEN")), nil
		}
		return []byte(pushedPr(g.tip, "MERGEABLE", "CLEAN", pushedRunningRollup, "OPEN")), nil
	}
	return []byte(`[]`), nil
}

func (g *pushGh) counts() (int, int) {
	g.lock.Lock()
	defer g.lock.Unlock()
	return g.views, g.lists
}

func (g *pushGh) pushTo(tip string) {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.tip = tip
}

// pushFixture: a project listed once with the old head, a Reviews that follows a push every millisecond, and the
// answers it publishes.
type pushFixture struct {
	t       *testing.T
	dir     string
	gh      *pushGh
	reviews *Reviews
	lock    sync.Mutex
	answers []ReviewsAnswer
}

func makePushFixture(t *testing.T) *pushFixture {
	dir := reviewsProject(t, reviewsSfManifest)
	f := &pushFixture{t: t, dir: dir, gh: &pushGh{tip: pushedOldHead, state: "OPEN", unknownReads: 2}}
	collector := testCollector(t, "", f.gh.run, nil)
	f.reviews = MakeReviews(collector, f.gh.run, func(answer ReviewsAnswer) {
		f.lock.Lock()
		defer f.lock.Unlock()
		f.answers = append(f.answers, answer)
	})
	f.reviews.followEvery = time.Millisecond
	t.Cleanup(func() { waitFollowsIdle(t, f.reviews) })
	readyReviews(t, f.reviews, dir)
	return f
}

func waitFollowsIdle(t *testing.T, r *Reviews) {
	t.Helper()
	// Generous: it only bounds a failing run, a passing one returns as soon as the reads end.
	deadline := time.Now().Add(time.Minute)
	for r.followsRunning() > 0 {
		if time.Now().After(deadline) {
			t.Errorf("reads of pushed PRs still going a minute after the test: %d", r.followsRunning())
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// pr9 is the PR as the list shows it now.
func (f *pushFixture) pr9() ReviewPr {
	f.t.Helper()
	answer, err := f.reviews.Get(ReviewsRequest{Dir: f.dir})
	if err != nil || len(answer.Ready) != 1 {
		f.t.Fatalf("the list: %+v %v", answer, err)
	}
	return answer.Ready[0]
}

// waitPublished waits for a published answer whose PR 9 satisfies ok.
func (f *pushFixture) waitPublished(what string, ok func(ReviewPr) bool) ReviewPr {
	f.t.Helper()
	// Generous: it only bounds a failing run.
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		f.lock.Lock()
		for _, answer := range f.answers {
			for _, pr := range answer.Ready {
				if pr.Number == 9 && ok(pr) {
					f.lock.Unlock()
					return pr
				}
			}
		}
		f.lock.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	f.t.Fatalf("no published answer shows %s", what)
	return ReviewPr{}
}

func rebasedAndClean(pr ReviewPr) bool {
	return pr.HeadOid == pushedNewHead && pr.Merge != ReviewMergeConflicts && pr.Merge != ReviewMergeUnknown
}

func TestTheListShowsTheOldHeadBeforeAPush(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	pr := f.pr9()
	if pr.HeadOid != pushedOldHead || pr.Merge != ReviewMergeConflicts || pr.Ci.State != ReviewCheckFailure {
		t.Fatalf("the list before the push: head %s merge %s ci %s", pr.HeadOid, pr.Merge, pr.Ci.State)
	}
}

// AC-1: the agent rebased and pushed; the repository watch sees origin's branch move, and the card stops saying
// "Conflicts with develop" with a red CI without any refresh asked: the PR is read again until GitHub has computed it.
func TestAPushSeenInTheRepositoryRefreshesTheListedPr(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.pushTo(pushedNewHead)
	f.reviews.RepoChanged(f.dir)
	pr := f.waitPublished("the pushed head, rebased and clean", rebasedAndClean)
	if pr.Ci.State != ReviewCheckPending {
		t.Errorf("the new head's checks run: %s", pr.Ci.State)
	}
	if views, lists := f.gh.counts(); views < 3 || lists != 1 {
		t.Errorf("the PR is read alone until GitHub computed it (views %d), the whole list once (lists %d)", views, lists)
	}
	if listed := f.pr9(); !rebasedAndClean(listed) {
		t.Errorf("the next list answer follows: head %s merge %s", listed.HeadOid, listed.Merge)
	}
}

// AC-1: the push the agent MoltenTerm follows reports counts as much as the one the watch sees.
func TestAPushReportedByTheAgentRefreshesTheListedPr(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.pushTo(pushedNewHead)
	f.reviews.HeadPushed(f.dir, "fix/9-x", pushedNewHead)
	f.waitPublished("the pushed head, rebased and clean", rebasedAndClean)
}

// A push reported without its head: the PR is read until GitHub shows another head than the listed one.
func TestAPushWithoutItsHeadIsFollowedUntilTheHeadMoves(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.pushTo(pushedNewHead)
	f.reviews.HeadPushed(f.dir, "fix/9-x", "")
	f.waitPublished("the pushed head, rebased and clean", rebasedAndClean)
}

// A PR merged or closed before the read leaves the list instead of staying with its old state.
func TestAPushedPrThatIsNotOpenLeavesTheList(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.lock.Lock()
	f.gh.state = "MERGED"
	f.gh.tip = pushedNewHead
	f.gh.lock.Unlock()
	f.reviews.RepoChanged(f.dir)
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		f.lock.Lock()
		n := len(f.answers)
		var last ReviewsAnswer
		if n > 0 {
			last = f.answers[n-1]
		}
		f.lock.Unlock()
		if n > 0 && len(last.Ready) == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the merged PR stayed in the list")
}

// Nothing moved on origin: no read of the PR, however often the repository changes.
func TestNoPushNoRead(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.pushTo(pushedOldHead)
	for i := 0; i < 3; i++ {
		f.reviews.RepoChanged(f.dir)
	}
	waitFollowsIdle(t, f.reviews)
	if views, _ := f.gh.counts(); views != 0 {
		t.Errorf("%d reads of the PR with no push", views)
	}
}

// A repository change in a project no view looks at reads nothing (FR-PERF-011).
func TestAPushInAProjectNoViewLooksAtReadsNothing(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.reviews.collector.lock.Lock()
	f.reviews.collector.now = func() time.Time { return time.Now().Add(time.Hour) }
	f.reviews.collector.lock.Unlock()
	f.gh.pushTo(pushedNewHead)
	f.reviews.RepoChanged(f.dir)
	waitFollowsIdle(t, f.reviews)
	if views, _ := f.gh.counts(); views != 0 {
		t.Errorf("%d reads of the PR in a project nobody looks at", views)
	}
}

// The same push is followed once, however many repository changes announce it.
func TestAPushIsFollowedOnce(t *testing.T) {
	t.Parallel()
	f := makePushFixture(t)
	f.pr9()
	f.gh.pushTo(pushedNewHead)
	f.reviews.RepoChanged(f.dir)
	f.waitPublished("the pushed head, rebased and clean", rebasedAndClean)
	waitFollowsIdle(t, f.reviews)
	views, _ := f.gh.counts()
	f.reviews.RepoChanged(f.dir)
	waitFollowsIdle(t, f.reviews)
	if again, _ := f.gh.counts(); again != views {
		t.Errorf("the followed push was read again: %d then %d", views, again)
	}
}

// A full read of the list that started before a push finishes after the PR was read alone: it must not bring the old
// head back; one that started after the push is the newer word.
func TestAFullReadStartedBeforeAPushDoesNotUndoIt(t *testing.T) {
	t.Parallel()
	dir := reviewsProject(t, reviewsSfManifest)
	c := testCollector(t, "", withoutGh, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	oldList := json.RawMessage("[" + pushedPr(pushedOldHead, "CONFLICTING", "DIRTY", pushedRedRollup, "OPEN") + "]")
	github := func(prs json.RawMessage) *GithubSnapshot {
		return &GithubSnapshot{State: GithubStateOk, Repo: "acme/app", Url: "https://github.com/acme/app", Prs: prs}
	}
	c.applyRefresh(dir, refreshPlan{github: true, startedAt: now}, nil, nil, github(oldList))
	started := now
	now = now.Add(time.Second)
	pushed := json.RawMessage(pushedPr(pushedNewHead, "MERGEABLE", "CLEAN", pushedRunningRollup, "OPEN"))
	if _, ok := c.ReplacePr(dir, 9, pushed, true); !ok {
		t.Fatal("the PR is in the list")
	}
	now = now.Add(time.Second)
	snap := c.applyRefresh(dir, refreshPlan{github: true, startedAt: started}, nil, nil, github(oldList))
	if got := BuildReviews(Snapshot{Dir: dir, Github: snap.Github}).Ready; len(got) != 1 || got[0].HeadOid != pushedNewHead {
		t.Fatalf("the read that started before the push undid it: %+v", got)
	}
	now = now.Add(time.Second)
	snap = c.applyRefresh(dir, refreshPlan{github: true, startedAt: now}, nil, nil, github(oldList))
	if got := BuildReviews(Snapshot{Dir: dir, Github: snap.Github}).Ready; len(got) != 1 || got[0].HeadOid != pushedOldHead {
		t.Fatalf("a read that started after the push is the newer word: %+v", got)
	}
}

func TestWithPrReplacesAndRemoves(t *testing.T) {
	t.Parallel()
	list := json.RawMessage(`[{"number":1,"title":"a"},{"number":2,"title":"b"},{"number":3,"title":"c"}]`)
	replaced, ok := withPr(list, 2, json.RawMessage(`{"number":2,"title":"B"}`), true)
	if !ok || string(replaced) != `[{"number":1,"title":"a"},{"number":2,"title":"B"},{"number":3,"title":"c"}]` {
		t.Errorf("replaced: %s %v", replaced, ok)
	}
	removed, ok := withPr(list, 3, nil, false)
	if !ok || string(removed) != `[{"number":1,"title":"a"},{"number":2,"title":"b"}]` {
		t.Errorf("removed: %s %v", removed, ok)
	}
	if same, ok := withPr(list, 9, json.RawMessage(`{"number":9}`), true); ok || !strings.Contains(string(same), `"number":3`) {
		t.Errorf("a PR the list does not hold is not added: %s %v", same, ok)
	}
	if string(list) != `[{"number":1,"title":"a"},{"number":2,"title":"b"},{"number":3,"title":"c"}]` {
		t.Errorf("the list given must stay as it was: %s", list)
	}
}
