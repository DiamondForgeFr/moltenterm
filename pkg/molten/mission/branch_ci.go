// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The trunk and release branches' GitHub CI (#836), which a release waits on: the latest run of each workflow on
// develop and main, its jobs folded as the Reviews list folds a PR's checks (#797), how long each usually takes, and
// whether the release followed is waiting for it.

const (
	BranchCiCommand = "moltenmissionbranchci"

	BranchCiRoleTrunk   = "trunk"
	BranchCiRoleRelease = "release"

	branchCiTimeout   = 45 * time.Second
	branchCiRunsLimit = "30"
	// The earlier green runs of a workflow whose durations make its usual one.
	branchCiUsualRuns = 3
	// Completed runs' jobs never change: they are kept, up to this many, then forgotten all at once.
	branchCiJobsCacheMax = 300
)

const branchRunFields = "databaseId,workflowName,event,status,conclusion,headBranch,headSha,displayTitle,createdAt,updatedAt,startedAt,url,attempt"

// The events whose runs are not the branch's own CI: scheduled ones keep their block, pull requests are in Reviews.
var branchCiSkippedEvents = map[string]bool{"schedule": true, "pull_request": true, "pull_request_target": true}

// What `molten release promote` prints while it waits for the trunk's CI (pkg/molten/release/ci.go requireCi).
var promoteCiHeaderRe = regexp.MustCompile(`^GitHub CI on (\S+) ([0-9a-f]{4,40}):$`)
var promoteCiWaitingRe = regexp.MustCompile(`^  waiting for (.+?)…$`)

type BranchCiRequest struct {
	Dir string `json:"dir"`
}

// ReleaseCiAwait is the CI a step of the release followed waits on: the workflows of a branch's commit.
type ReleaseCiAwait struct {
	Tag       string   `json:"tag"`
	Branch    string   `json:"branch"`
	Sha       string   `json:"sha"`
	Workflows []string `json:"workflows,omitempty"`
}

type BranchCiJob struct {
	Name        string   `json:"name"`
	State       string   `json:"state"`
	Status      string   `json:"status,omitempty"`
	StartedAt   string   `json:"startedat,omitempty"`
	CompletedAt string   `json:"completedat,omitempty"`
	Url         string   `json:"url,omitempty"`
	UsualMs     int64    `json:"usualms,omitempty"`
	FailedSteps []string `json:"failedsteps,omitempty"`
}

type BranchCiRun struct {
	DatabaseId   int64  `json:"databaseId"`
	WorkflowName string `json:"workflowName"`
	Event        string `json:"event"`
	Status       string `json:"status"`
	Conclusion   string `json:"conclusion"`
	HeadBranch   string `json:"headBranch"`
	HeadSha      string `json:"headSha"`
	DisplayTitle string `json:"displayTitle"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	StartedAt    string `json:"startedAt"`
	Url          string `json:"url"`
	Attempt      int    `json:"attempt"`
	// The usual duration of the workflow on this branch, from its last green runs.
	UsualMs   int64         `json:"usualms,omitempty"`
	Ci        ReviewCi      `json:"ci"`
	Jobs      []BranchCiJob `json:"jobs"`
	JobsError string        `json:"jobserror,omitempty"`
	// The release followed waits for this run (its tag).
	AwaitedBy string `json:"awaitedby,omitempty"`
}

type BranchCiBranch struct {
	Branch string        `json:"branch"`
	Roles  []string      `json:"roles"`
	Runs   []BranchCiRun `json:"runs"`
	Error  string        `json:"error,omitempty"`
}

type BranchCiAnswer struct {
	Dir      string           `json:"dir"`
	State    string           `json:"state,omitempty"`
	Branches []BranchCiBranch `json:"branches"`
	Awaits   *ReleaseCiAwait  `json:"awaits,omitempty"`
}

type ghBranchJobStep struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

type ghBranchJob struct {
	Name        string            `json:"name"`
	Status      string            `json:"status"`
	Conclusion  string            `json:"conclusion"`
	StartedAt   string            `json:"startedAt"`
	CompletedAt string            `json:"completedAt"`
	Url         string            `json:"url"`
	Steps       []ghBranchJobStep `json:"steps"`
}

type BranchCi struct {
	lock      sync.Mutex
	collector *Collector
	runs      *Runs
	run       Runner
	jobs      map[string][]ghBranchJob
}

func MakeBranchCi(collector *Collector, runs *Runs, run Runner) *BranchCi {
	return &BranchCi{collector: collector, runs: runs, run: run, jobs: map[string][]ghBranchJob{}}
}

// awaitedCiOf reads a release step's log: the promotion is waiting when its last "GitHub CI on" header is followed
// only by its own indented lines, none saying green yet.
func awaitedCiOf(log []byte) *ReleaseCiAwait {
	lines := strings.Split(string(log), "\n")
	var rtn *ReleaseCiAwait
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if m := promoteCiHeaderRe.FindStringSubmatch(line); m != nil {
			rtn = &ReleaseCiAwait{Branch: m[1], Sha: m[2]}
			continue
		}
		if rtn == nil {
			continue
		}
		if !strings.HasPrefix(line, "  ") || strings.HasSuffix(line, ": green") {
			rtn = nil
			continue
		}
		if m := promoteCiWaitingRe.FindStringSubmatch(line); m != nil {
			rtn.Workflows = strings.Split(m[1], ", ")
		}
	}
	return rtn
}

// awaitedCi is the CI a running step of the release waits on, if any.
func (r *Runs) awaitedCi(dir string, tag string, since int64) *ReleaseCiAwait {
	for _, rec := range r.List(dir) {
		if rec.Kind != RunKindRelease || rec.Tag != tag || rec.StartedAt < since || rec.State != RunStateRunning {
			continue
		}
		data, err := os.ReadFile(r.logFile(dir, rec.Id))
		if err != nil {
			continue
		}
		if awaits := awaitedCiOf(data); awaits != nil {
			awaits.Tag = tag
			return awaits
		}
	}
	return nil
}

// AwaitedCi is the CI the release followed waits on, read from this computer only (no git fetch, no gh).
func (r *Runs) AwaitedCi(dir string) *ReleaseCiAwait {
	session, _ := r.ReleaseSessionOf(dir)
	if session == nil {
		return nil
	}
	return r.awaitedCi(dir, session.Tag, session.StartedAt)
}

// workflowNames maps the workflow files the promotion names (ci.yml) to the names GitHub shows (CI).
func workflowNames(dir string, files []string) map[string]bool {
	rtn := map[string]bool{}
	byFile := map[string]string{}
	for _, wf := range ReadWorkflowFiles(dir) {
		byFile[wf.Name] = workflowDisplayName(wf)
	}
	for _, file := range files {
		if name, ok := byFile[file]; ok {
			rtn[name] = true
			continue
		}
		rtn[file] = true
	}
	return rtn
}

var workflowNameRe = regexp.MustCompile(`(?m)^name:\s*["']?(.+?)["']?\s*$`)

// workflowDisplayName is the workflow's top-level name, else its file's path as GitHub shows a nameless one.
func workflowDisplayName(wf WorkflowFile) string {
	if m := workflowNameRe.FindStringSubmatch(wf.Text); m != nil {
		return m[1]
	}
	return ".github/workflows/" + wf.Name
}

func parseGhTime(s string) (time.Time, bool) {
	if s == "" || strings.HasPrefix(s, "0001-") {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil
}

func spanMs(from string, to string) int64 {
	start, ok1 := parseGhTime(from)
	end, ok2 := parseGhTime(to)
	if !ok1 || !ok2 || end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}

func medianMs(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64{}, values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	mid := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[mid-1] + sorted[mid]) / 2
	}
	return sorted[mid]
}

func runStartedAt(run BranchCiRun) string {
	if _, ok := parseGhTime(run.StartedAt); ok {
		return run.StartedAt
	}
	return run.CreatedAt
}

func isGreenRun(run BranchCiRun) bool {
	return strings.EqualFold(run.Status, "completed") && strings.EqualFold(run.Conclusion, "success")
}

func (b *BranchCi) cachedJobs(key string) ([]ghBranchJob, bool) {
	b.lock.Lock()
	defer b.lock.Unlock()
	jobs, ok := b.jobs[key]
	return jobs, ok
}

func (b *BranchCi) storeJobs(key string, jobs []ghBranchJob) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if len(b.jobs) >= branchCiJobsCacheMax {
		b.jobs = map[string][]ghBranchJob{}
	}
	b.jobs[key] = jobs
}

func (b *BranchCi) readJobs(ctx context.Context, dir string, repoRef string, run BranchCiRun) ([]ghBranchJob, error) {
	completed := strings.EqualFold(run.Status, "completed")
	key := dir + "\x00" + strconv.FormatInt(run.DatabaseId, 10) + "\x00" + strconv.Itoa(run.Attempt) + "\x00" + run.UpdatedAt
	if completed {
		if jobs, ok := b.cachedJobs(key); ok {
			return jobs, nil
		}
	}
	out, err := ghJson(ctx, b.run, dir, ghRepoArgs(repoRef, []string{"run", "view", strconv.FormatInt(run.DatabaseId, 10), "--json", "jobs"})...)
	if err != nil {
		return nil, err
	}
	var view struct {
		Jobs []ghBranchJob `json:"jobs"`
	}
	if err := json.Unmarshal(out, &view); err != nil {
		return nil, err
	}
	if completed {
		b.storeJobs(key, view.Jobs)
	}
	return view.Jobs, nil
}

// foldJobs folds a run's jobs with the Reviews list's fold (SummarizeReviewChecks), then gives each its times, its
// failed steps and its usual duration.
func foldJobs(workflow string, jobs []ghBranchJob, usual map[string]int64) (ReviewCi, []BranchCiJob) {
	rollup := make([]ghReviewRollup, 0, len(jobs))
	byName := map[string]ghBranchJob{}
	for _, job := range jobs {
		rollup = append(rollup, ghReviewRollup{Name: job.Name, Status: job.Status, Conclusion: job.Conclusion,
			WorkflowName: workflow, StartedAt: job.StartedAt, CompletedAt: job.CompletedAt, DetailsUrl: job.Url})
		byName[job.Name] = job
	}
	ci := SummarizeReviewChecks(rollup)
	rtn := make([]BranchCiJob, 0, len(ci.Checks))
	for _, check := range ci.Checks {
		job := byName[check.Name]
		row := BranchCiJob{Name: check.Name, State: check.State, Status: strings.ToLower(job.Status), StartedAt: job.StartedAt,
			CompletedAt: job.CompletedAt, Url: check.Url, UsualMs: usual[check.Name]}
		for _, step := range job.Steps {
			if strings.EqualFold(step.Conclusion, "failure") || strings.EqualFold(step.Conclusion, "timed_out") {
				row.FailedSteps = append(row.FailedSteps, step.Name)
			}
		}
		rtn = append(rtn, row)
	}
	return ci, rtn
}

// latestRuns keeps the branch's own runs, newest first, and picks the latest of each workflow with the earlier green
// ones that make its usual duration.
func latestRuns(runs []BranchCiRun, branch string) ([]BranchCiRun, map[string][]BranchCiRun) {
	own := make([]BranchCiRun, 0, len(runs))
	for _, run := range runs {
		if run.HeadBranch != branch || branchCiSkippedEvents[run.Event] {
			continue
		}
		own = append(own, run)
	}
	sort.SliceStable(own, func(i, j int) bool { return own[i].CreatedAt > own[j].CreatedAt })
	latest := []BranchCiRun{}
	earlier := map[string][]BranchCiRun{}
	seen := map[string]bool{}
	for _, run := range own {
		if !seen[run.WorkflowName] {
			seen[run.WorkflowName] = true
			latest = append(latest, run)
			continue
		}
		if isGreenRun(run) && len(earlier[run.WorkflowName]) < branchCiUsualRuns {
			earlier[run.WorkflowName] = append(earlier[run.WorkflowName], run)
		}
	}
	sort.SliceStable(latest, func(i, j int) bool { return latest[i].WorkflowName < latest[j].WorkflowName })
	return latest, earlier
}

func (b *BranchCi) usualJobs(ctx context.Context, dir string, repoRef string, earlier []BranchCiRun) map[string]int64 {
	spans := map[string][]int64{}
	for _, run := range earlier {
		jobs, err := b.readJobs(ctx, dir, repoRef, run)
		if err != nil {
			continue
		}
		for _, job := range jobs {
			if !strings.EqualFold(job.Conclusion, "success") {
				continue
			}
			if ms := spanMs(job.StartedAt, job.CompletedAt); ms > 0 {
				spans[job.Name] = append(spans[job.Name], ms)
			}
		}
	}
	rtn := map[string]int64{}
	for name, values := range spans {
		rtn[name] = medianMs(values)
	}
	return rtn
}

func (b *BranchCi) readBranch(ctx context.Context, dir string, repoRef string, branch BranchCiBranch, awaits *ReleaseCiAwait, awaitedNames map[string]bool) BranchCiBranch {
	out, err := ghJson(ctx, b.run, dir, ghRepoArgs(repoRef, []string{"run", "list", "--branch", branch.Branch, "--limit", branchCiRunsLimit, "--json", branchRunFields})...)
	if err != nil {
		branch.Error = err.Error()
		return branch
	}
	var runs []BranchCiRun
	if err := json.Unmarshal(out, &runs); err != nil {
		branch.Error = "the runs of " + branch.Branch + " could not be read: " + err.Error()
		return branch
	}
	latest, earlier := latestRuns(runs, branch.Branch)
	for _, run := range latest {
		var spans []int64
		for _, prev := range earlier[run.WorkflowName] {
			if ms := spanMs(runStartedAt(prev), prev.UpdatedAt); ms > 0 {
				spans = append(spans, ms)
			}
		}
		run.UsualMs = medianMs(spans)
		jobs, err := b.readJobs(ctx, dir, repoRef, run)
		if err != nil {
			run.JobsError = err.Error()
			run.Ci = ReviewCi{State: ReviewCheckNone, Checks: []ReviewCheck{}}
			run.Jobs = []BranchCiJob{}
		} else {
			run.Ci, run.Jobs = foldJobs(run.WorkflowName, jobs, b.usualJobs(ctx, dir, repoRef, earlier[run.WorkflowName]))
		}
		if awaits != nil && awaits.Branch == branch.Branch && strings.HasPrefix(run.HeadSha, awaits.Sha) &&
			(len(awaitedNames) == 0 || awaitedNames[run.WorkflowName]) {
			run.AwaitedBy = awaits.Tag
		}
		branch.Runs = append(branch.Runs, run)
	}
	return branch
}

// trunkAndRelease names the branches read: the trunk first, then the release branch, once when they are the same.
func trunkAndRelease(dir string) []BranchCiBranch {
	branches := molten.ResolvedBranches(dir)
	rtn := []BranchCiBranch{{Branch: branches.Trunk, Roles: []string{BranchCiRoleTrunk}, Runs: []BranchCiRun{}}}
	if branches.Release == branches.Trunk {
		rtn[0].Roles = append(rtn[0].Roles, BranchCiRoleRelease)
		return rtn
	}
	return append(rtn, BranchCiBranch{Branch: branches.Release, Roles: []string{BranchCiRoleRelease}, Runs: []BranchCiRun{}})
}

// Get reads the trunk and release branches' CI of the folder's GitHub repository, once Mission Control read the
// repository itself (the collector's snapshot names it, so gh never picks another remote).
func (b *BranchCi) Get(req BranchCiRequest) (BranchCiAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return BranchCiAnswer{}, err
	}
	dir := filepath.Clean(req.Dir)
	answer := BranchCiAnswer{Dir: dir, Branches: []BranchCiBranch{}}
	snap, ok := b.collector.Cached(dir)
	if !ok || snap.Github == nil {
		return answer, nil
	}
	answer.State = snap.Github.State
	if snap.Github.State != GithubStateOk {
		return answer, nil
	}
	if b.runs != nil {
		answer.Awaits = b.runs.AwaitedCi(dir)
	}
	var awaitedNames map[string]bool
	if answer.Awaits != nil {
		awaitedNames = workflowNames(dir, answer.Awaits.Workflows)
	}
	repoRef := ghRepoRef(snap.Github.Repo, snap.Github.Url)
	ctx, cancel := context.WithTimeout(context.Background(), branchCiTimeout)
	defer cancel()
	for _, branch := range trunkAndRelease(dir) {
		answer.Branches = append(answer.Branches, b.readBranch(ctx, dir, repoRef, branch, answer.Awaits, awaitedNames))
	}
	return answer, nil
}
