// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const rerunPrs = `[
 {"number":21,"title":"red","headRefName":"fix/5-x","baseRefName":"develop","isDraft":false,"updatedAt":"2026-10-12T10:00:00Z","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED",
  "statusCheckRollup":[
   {"name":"Backend","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-12T10:00:00Z","detailsUrl":"https://github.com/acme/app/actions/runs/900/job/9001"},
   {"name":"Required gate","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-12T10:05:00Z","detailsUrl":"https://github.com/acme/app/actions/runs/900/job/9002"},
   {"name":"Lint","workflowName":"Lint","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-12T10:00:00Z","detailsUrl":"https://github.com/acme/app/actions/runs/800/job/8001"},
   {"name":"Frontend","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-12T10:00:00Z","detailsUrl":"https://github.com/acme/app/actions/runs/900/job/9003"}]},
 {"number":22,"title":"green","headRefName":"fix/6-y","baseRefName":"develop","isDraft":false,"updatedAt":"2026-10-12T09:00:00Z","mergeStateStatus":"CLEAN",
  "statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}]}
]`

type rerunGh struct {
	lock  sync.Mutex
	calls []string
}

func (g *rerunGh) run(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return nil, errors.New("no git here")
	}
	g.lock.Lock()
	g.calls = append(g.calls, strings.Join(args, " "))
	g.lock.Unlock()
	switch {
	case args[0] == "repo":
		return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
	case args[0] == "pr":
		return []byte(rerunPrs), nil
	case args[0] == "run" && args[1] == "view" && args[2] == "800":
		return []byte(`{"status":"completed","conclusion":"success","jobs":[{"name":"Lint","conclusion":"success"}]}`), nil
	case args[0] == "run" && args[1] == "view":
		return []byte(`{"status":"completed","conclusion":"failure","jobs":[{"name":"Backend","conclusion":"failure"},{"name":"Frontend","conclusion":"success"}]}`), nil
	case args[0] == "run":
		return nil, nil
	}
	return []byte(`[]`), nil
}

func (g *rerunGh) called(prefix string) []string {
	g.lock.Lock()
	defer g.lock.Unlock()
	var rtn []string
	for _, c := range g.calls {
		if strings.HasPrefix(c, prefix) {
			rtn = append(rtn, c)
		}
	}
	return rtn
}

func readyReviews(t *testing.T, reviews *Reviews, dir string) {
	t.Helper()
	// Generous: it only bounds a failing run.
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		answer, err := reviews.Get(ReviewsRequest{Dir: dir})
		if err != nil {
			t.Fatal(err)
		}
		if answer.State == GithubStateOk {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the collector never read GitHub")
}

// #797: Rerun failed jobs reruns each run holding a failed check, naming the repository, and tells the outcome.
func TestReviewsRerunFailed(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	gh := &rerunGh{}
	collector := MakeCollector("", gh.run, nil)
	reviews := MakeReviews(collector, gh.run, nil)
	told := make(chan molten.NotificationInput, 1)
	reviews.notify = func(ctx context.Context, input molten.NotificationInput) error {
		told <- input
		return nil
	}
	reviews.rerunEvery = time.Millisecond
	readyReviews(t, reviews, dir)
	if _, err := reviews.RerunFailed(ReviewsRerunRequest{Dir: dir, Number: 22}); err == nil || !strings.Contains(err.Error(), "nothing to rerun") {
		t.Fatalf("a green PR: %v", err)
	}
	if _, err := reviews.RerunFailed(ReviewsRerunRequest{Dir: dir, Number: 99}); err == nil {
		t.Fatal("an unknown PR was rerun")
	}
	got, err := reviews.RerunFailed(ReviewsRerunRequest{Dir: dir, Number: 21})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Runs) != 2 || got.Runs[0] != 800 || got.Runs[1] != 900 || strings.Join(got.Checks, ",") != "Backend,Lint,Required gate" {
		t.Fatalf("got %+v", got)
	}
	reruns := gh.called("run rerun")
	if strings.Join(reruns, "|") != "run rerun 800 --failed --repo acme/app|run rerun 900 --failed --repo acme/app" {
		t.Fatalf("reruns: %v", reruns)
	}
	select {
	case input := <-told:
		if input.Kind != "warning" || input.TitleText == nil || input.TitleText.Code != "notif.review.rerun.failedTitle" ||
			!strings.Contains(input.Message, "Backend") || strings.Contains(input.Message, "Frontend") {
			t.Fatalf("told %+v", input)
		}
	case <-time.After(time.Minute):
		t.Fatal("the rerun's outcome was never told")
	}
	if views := gh.called("run view 900 --json status,conclusion,url,jobs --repo acme/app"); len(views) == 0 {
		t.Fatalf("the run was not read with its repository: %v", gh.called("run view"))
	}
}
