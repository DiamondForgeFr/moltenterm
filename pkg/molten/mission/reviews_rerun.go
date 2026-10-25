// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Rerun failed jobs (#797): a Reviews row's action on a PR whose check failed, after the developer confirmed in the
// row. The runs come from the PR's checks as the collector read them, never from the window: wavesrv reruns the
// failed jobs of each run that holds a failed check, through the developer's gh and naming the repository, reads
// GitHub again, then follows the runs and tells their outcome by a notification.

// must match frontend/moltenterm-shell/reviews/reviews-client.ts
const ReviewsRerunCommand = "moltenmissionreviewsrerun"

const (
	rerunTimeout     = 45 * time.Second
	rerunFollowEvery = 30 * time.Second
	// A run still going after this is left to the list: the notification would come too late to help.
	rerunFollowMax  = 2 * time.Hour
	reviewsViewName = "molten-reviews"
)

type ReviewsRerunRequest struct {
	Dir    string `json:"dir"`
	Number int    `json:"number"`
}

type ReviewsRerunResult struct {
	Runs   []int64  `json:"runs"`
	Checks []string `json:"checks"`
}

type ghRunJob struct {
	Name       string `json:"name"`
	Conclusion string `json:"conclusion"`
}

type ghRunState struct {
	Status     string     `json:"status"`
	Conclusion string     `json:"conclusion"`
	Url        string     `json:"url"`
	Jobs       []ghRunJob `json:"jobs"`
}

// failedRuns are the runs holding a failed check of the PR, and those checks' names, as the snapshot has them.
func failedRuns(answer ReviewsAnswer, number int) ([]int64, []string, bool) {
	for _, pr := range append(append([]ReviewPr{}, answer.Ready...), answer.Drafts...) {
		if pr.Number != number {
			continue
		}
		seen := map[int64]bool{}
		var runs []int64
		var names []string
		for _, check := range pr.Ci.Checks {
			if check.State != ReviewCheckFailure || check.RunId <= 0 {
				continue
			}
			names = append(names, check.Name)
			if !seen[check.RunId] {
				seen[check.RunId] = true
				runs = append(runs, check.RunId)
			}
		}
		sort.Slice(runs, func(i, j int) bool { return runs[i] < runs[j] })
		return runs, names, true
	}
	return nil, nil, false
}

// RerunFailed reruns the failed jobs of the PR's failed checks (`gh run rerun <id> --failed`).
func (r *Reviews) RerunFailed(req ReviewsRerunRequest) (ReviewsRerunResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return ReviewsRerunResult{}, err
	}
	if req.Number <= 0 {
		return ReviewsRerunResult{}, fmt.Errorf("number must name the pull request")
	}
	dir := filepath.Clean(req.Dir)
	snap, ok := r.collector.Cached(dir)
	if !ok {
		return ReviewsRerunResult{}, uimsg.Errorf(uimsg.Make("mission.reviews.rerunUnknown", "number", strconv.Itoa(req.Number)),
			"MoltenTerm has not read #%d on GitHub yet", req.Number)
	}
	answer := BuildReviews(snap)
	runs, names, found := failedRuns(answer, req.Number)
	if !found {
		return ReviewsRerunResult{}, uimsg.Errorf(uimsg.Make("mission.reviews.rerunUnknown", "number", strconv.Itoa(req.Number)),
			"MoltenTerm has not read #%d on GitHub yet", req.Number)
	}
	if len(runs) == 0 {
		return ReviewsRerunResult{}, uimsg.Errorf(uimsg.Make("mission.reviews.rerunNothing", "number", strconv.Itoa(req.Number)),
			"no GitHub Actions check of #%d failed: nothing to rerun", req.Number)
	}
	repoRef := ghRepoRef(answer.Repo, answer.Url)
	ctx, cancel := context.WithTimeout(context.Background(), rerunTimeout)
	defer cancel()
	for _, id := range runs {
		args := ghRepoArgs(repoRef, []string{"run", "rerun", strconv.FormatInt(id, 10), "--failed"})
		if _, err := r.run(ctx, dir, "gh", args...); err != nil {
			return ReviewsRerunResult{}, uimsg.Errorf(uimsg.Make("mission.reviews.rerunFailed", "detail", uimsg.Detail(err)),
				"the failed jobs could not be rerun: %v", err)
		}
	}
	r.collector.Get(dir, 0, true)
	go r.followRerun(dir, repoRef, req.Number, runs)
	return ReviewsRerunResult{Runs: runs, Checks: names}, nil
}

func (r *Reviews) readRun(dir string, repoRef string, id int64) (ghRunState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), rerunTimeout)
	defer cancel()
	args := ghRepoArgs(repoRef, []string{"run", "view", strconv.FormatInt(id, 10), "--json", "status,conclusion,url,jobs"})
	out, err := r.run(ctx, dir, "gh", args...)
	if err != nil {
		return ghRunState{}, err
	}
	var state ghRunState
	if err := json.Unmarshal(out, &state); err != nil {
		return ghRunState{}, err
	}
	return state, nil
}

// followRerun reads the rerun runs until each completed, then reads GitHub again and tells the outcome.
func (r *Reviews) followRerun(dir string, repoRef string, number int, runs []int64) {
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:mission:reviews:rerun", rec)
		}
	}()
	every := r.rerunEvery
	if every <= 0 {
		every = rerunFollowEvery
	}
	deadline := r.now().Add(rerunFollowMax)
	done := map[int64]ghRunState{}
	for len(done) < len(runs) {
		if r.now().After(deadline) {
			return
		}
		time.Sleep(every)
		for _, id := range runs {
			if _, ok := done[id]; ok {
				continue
			}
			state, err := r.readRun(dir, repoRef, id)
			if err != nil {
				log.Printf("molten: following the rerun of run %d: %v\n", id, err)
				continue
			}
			if strings.EqualFold(state.Status, "completed") {
				done[id] = state
			}
		}
	}
	r.collector.Get(dir, 0, true)
	r.notifyRerun(number, runs, done)
}

func (r *Reviews) notifyRerun(number int, runs []int64, done map[int64]ghRunState) {
	if r.notify == nil {
		return
	}
	var failed []string
	for _, id := range runs {
		state := done[id]
		if strings.EqualFold(state.Conclusion, "success") {
			continue
		}
		for _, job := range state.Jobs {
			if containsWord(reviewFailureWords, strings.ToUpper(job.Conclusion)) {
				failed = append(failed, job.Name)
			}
		}
		if len(state.Jobs) == 0 {
			failed = append(failed, "run "+strconv.FormatInt(id, 10))
		}
	}
	n := strconv.Itoa(number)
	input := molten.NotificationInput{
		Key:     "review:rerun:" + n,
		Source:  "github",
		Actions: []molten.NotificationAction{{Id: "reviews", Label: "Open the Control room", Kind: "open", View: reviewsViewName, LabelText: uimsg.Make("notif.review.batch.openReviews")}},
	}
	if len(failed) == 0 {
		input.Kind = "success"
		input.Title = "#" + n + ": the rerun jobs passed"
		input.TitleText = uimsg.Make("notif.review.rerun.passedTitle", "number", n)
	} else {
		names := strings.Join(failed, ", ")
		input.Kind = "warning"
		input.Title = "#" + n + ": failed again after the rerun"
		input.TitleText = uimsg.Make("notif.review.rerun.failedTitle", "number", n)
		input.Message = "Still failing: " + names + ". Investigate from the pull request's row in the Control room."
		input.MessageText = uimsg.Make("notif.review.rerun.failed", "names", names)
	}
	ctx, cancel := context.WithTimeout(context.Background(), rerunTimeout)
	defer cancel()
	if err := r.notify(ctx, input); err != nil {
		log.Printf("molten: the rerun of #%d could not be told: %v\n", number, err)
	}
}
