// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// A trunk that is red with no open pull request is a block too (FR-REV-036 AC16), and the fixes of the blocks reach the
// answer (AC9 to AC13).

// trunkRedGh answers the trunk's check runs and leaves the rest to the shared fake.
func trunkRedGh(gh *securityGh, runs string) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		if len(args) > 1 && args[0] == "api" && strings.Contains(strings.Join(args, " "), "/check-runs") {
			return []byte(`{"check_runs":[` + runs + `]}`), nil
		}
		return gh.run(ctx, dir, name, args...)
	}
}

const trunkScanRun = `{"name":"Dependency security / Scan dependencies","conclusion":"failure","html_url":"https://github.com/acme/app/actions/runs/901/job/9011"}`

func TestReviewsSecurityAssessesATrunkThatIsRedWithNoOpenPullRequest(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"901": securityReport}}
	reviews, dir := securityReviews(t, gh)
	clock := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	reviews.now = func() time.Time { return clock }
	reviews.run = trunkRedGh(gh, trunkScanRun)
	green := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))))
	assessNow(t, reviews, &green)

	answer := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))))
	reviews.applySecurity(&answer)
	if len(answer.SecurityBlocks) != 1 {
		t.Fatalf("one block, the trunk's: %+v", answer.SecurityBlocks)
	}
	block := answer.SecurityBlocks[0]
	if len(block.Prs) != 0 || !block.TrunkFailing || !block.Shared || block.TrunkRun != 901 || block.Fingerprint != secfix.Fingerprint([]string{"GO-2099-0001"}) {
		t.Fatalf("block = %+v", block)
	}
	for _, pr := range append(append([]ReviewPr{}, answer.Ready...), answer.Drafts...) {
		if pr.SecurityBlock != "" {
			t.Fatalf("no pull request is in it: #%d names %q", pr.Number, pr.SecurityBlock)
		}
	}
	result, ok := reviews.SecurityResult(dir)
	if !ok || len(result.Blocks) != 1 {
		t.Fatalf("the work that follows a shared block reads it: %+v %v", result, ok)
	}
	// The trunk turns green and the assessment is old enough to be read again: the block goes, and the launcher has nothing
	// left to read.
	clock = clock.Add(securityMaxAge)
	reviews.securityReader = secfix.MakeReader()
	reviews.run = trunkRedGh(gh, `{"name":"Frontend","conclusion":"success","html_url":"https://github.com/acme/app/actions/runs/902/job/9021"}`)
	assessNow(t, reviews, &green)
	cleared := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))))
	reviews.applySecurity(&cleared)
	if len(cleared.SecurityBlocks) != 0 {
		t.Fatalf("a trunk that passes again leaves no block: %+v", cleared.SecurityBlocks)
	}
}

// What the launcher is told of an assessment is the trunk's block alone when no pull request fails the scan any more: what
// was found of the pull requests is gone with their failure.
func TestReviewsSecurityToldTheObserverOnlyWhatStandsOnTheTrunk(t *testing.T) {
	serialTest(t)
	var lock sync.Mutex
	var told []SecurityAssessed
	SetSecurityObserver(func(assessed SecurityAssessed) {
		lock.Lock()
		defer lock.Unlock()
		told = append(told, assessed)
	})
	t.Cleanup(func() { SetSecurityObserver(nil) })
	gh := &securityGh{reports: map[string]string{"901": securityReport}}
	reviews, dir := securityReviews(t, gh)
	reviews.run = trunkRedGh(gh, trunkScanRun)
	green := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))))
	assessNow(t, reviews, &green)
	lock.Lock()
	defer lock.Unlock()
	if len(told) != 1 || told[0].Dir != dir || told[0].Repo != "acme/app" || told[0].Trunk != "develop" || len(told[0].Result.Blocks) != 1 || len(told[0].Result.Blocks[0].Prs) != 0 {
		t.Fatalf("told: %+v", told)
	}
}

func TestReviewsAnswerCarriesTheFixesInFlightAndTheOnesThatEndedLately(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{}}
	reviews, dir := securityReviews(t, gh)
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	reviews.now = func() time.Time { return now }
	reviews.securityFixes = secfix.MakeFixStore(filepath.Join(t.TempDir(), SecurityFixesFileName))
	reviews.securityFixes.UseClock(func() time.Time { return now })
	for i, state := range []string{secfix.FixWorking, secfix.FixMerged, secfix.FixStopped} {
		id := "GO-2099-000" + string(rune('1'+i))
		plan, _, err := reviews.securityFixes.Begin(dir, secfix.Fix{Ids: []string{id}}, false)
		if err != nil || plan != secfix.PlanLaunch {
			t.Fatalf("begin %s: %q %v", id, plan, err)
		}
		reviews.securityFixes.Update(dir, secfix.Fingerprint([]string{id}), func(f *secfix.Fix) bool { f.State = state; return true })
		now = now.Add(time.Minute)
		if state == secfix.FixWorking {
			// Only one fix is in flight at a time: end this one so the next can begin.
			reviews.securityFixes.Update(dir, secfix.Fingerprint([]string{id}), func(f *secfix.Fix) bool { f.State = secfix.FixMerged; return true })
		}
	}
	answer := BuildReviews(reviewsSnapshot(dir, `[]`))
	reviews.applySecurity(&answer)
	if len(answer.SecurityFixes) != 3 {
		t.Fatalf("every fix of the last two days: %+v", answer.SecurityFixes)
	}
	now = now.Add(securityFixesShownFor + time.Hour)
	// A fix that ended is never changed back by an update (only Begin starts a set again); a new one is in flight.
	if _, _, err := reviews.securityFixes.Update(dir, secfix.Fingerprint([]string{"GO-2099-0003"}), func(f *secfix.Fix) bool { f.State = secfix.FixWaiting; return true }); !errors.Is(err, secfix.ErrEnded) {
		t.Fatalf("a stopped fix is not woken by an update: %v", err)
	}
	if plan, _, err := reviews.securityFixes.Begin(dir, secfix.Fix{Ids: []string{"GO-2099-0004"}}, false); err != nil || plan != secfix.PlanLaunch {
		t.Fatalf("begin the fix in flight: %q %v", plan, err)
	}
	late := BuildReviews(reviewsSnapshot(dir, `[]`))
	reviews.applySecurity(&late)
	if len(late.SecurityFixes) != 1 || late.SecurityFixes[0].State != secfix.FixWaiting {
		t.Fatalf("what ended long ago goes, what is in flight stays: %+v", late.SecurityFixes)
	}
	var none *Reviews
	if none.SecurityFixes() != nil || len(none.fixesShown(dir)) != 0 {
		t.Fatal("a Mission Control that is not started holds no fixes")
	}
}

// What a fix works on is what the last assessment read: its repository and its trunk, never what a request says.
func TestSecurityScopeIsWhatTheLastAssessmentRead(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport}}
	reviews, dir := securityReviews(t, gh)
	if _, _, ok := reviews.SecurityScope(dir); ok {
		t.Fatal("nothing was assessed yet")
	}
	answer := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))))
	assessNow(t, reviews, &answer)
	if repo, trunk, ok := reviews.SecurityScope(dir); !ok || repo != "acme/app" || trunk != "develop" {
		t.Fatalf("scope = %q %q %v", repo, trunk, ok)
	}
	var none *Reviews
	if _, _, ok := none.SecurityScope(dir); ok {
		t.Fatal("a Mission Control that is not started has no scope")
	}
}

// A pull request from a fork never reaches an assessment, so it is never in a block: the list holds the repository's own
// pull requests only, and what a fork's CI wrote starts nothing.
func TestSecurityAssessmentNeverListsAForksPullRequest(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport, "502": securityReport}}
	reviews, dir := securityReviews(t, gh)
	var listed []map[string]any
	if err := json.Unmarshal([]byte(securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))), &listed); err != nil {
		t.Fatal(err)
	}
	var rollup []any
	if err := json.Unmarshal([]byte(`[`+scanRollup(502, 5021, "FAILURE")+`]`), &rollup); err != nil {
		t.Fatal(err)
	}
	listed = append(listed, map[string]any{"number": 23, "title": "fork", "headRefName": "fix/21-second", "baseRefName": "develop", "headRefOid": "ddd",
		"isDraft": false, "isCrossRepository": true, "updatedAt": "2026-10-12T11:00:00Z", "statusCheckRollup": rollup})
	data, err := json.Marshal(listed)
	if err != nil {
		t.Fatal(err)
	}
	answer := BuildReviews(reviewsSnapshot(dir, string(data)))
	input, ok := reviews.securityInput(answer)
	if !ok {
		t.Fatal("the answer was read")
	}
	for _, pr := range input.Prs {
		if pr.Number == 23 {
			t.Fatalf("a fork's pull request reaches the assessment: %+v", input.Prs)
		}
	}
	assessNow(t, reviews, &answer)
	result, found := reviews.SecurityResult(dir)
	if !found || len(result.Blocks) != 1 || result.PrOfBlock(23) != "" || len(result.Blocks[0].Prs) != 2 {
		t.Fatalf("the block holds the repository's own pull requests: %+v", result)
	}
}
