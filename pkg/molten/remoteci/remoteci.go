// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package remoteci tells whether GitHub already verified a commit in full (#2277): a commit that has a green run of the
// project's full suites is never verified again on this computer. It reads GitHub through the user's own gh, never a
// token of ours, and accepts a result only when it really stands for the CI:
//
//   - a workflow run of the project's own repository (the run and its head repository), on that exact commit, never a
//     branch name, and so produced by GitHub Actions;
//   - of a push, a manual dispatch or a schedule on the trunk or the release branch: a pull request's run, draft or
//     affected-only, tests less than the full suites;
//   - concluded success, with every check the branch requires (the required status checks of its rulesets) a job of
//     that run that concluded success. A skipped, missing or failed required job does not count, and a branch that
//     declares no required check accepts no run, since nothing tells its CI from any other workflow. A caller that names
//     the workflow itself (the release flow) takes that workflow's own conclusion instead.
//
// Anything else, and any error (offline, rate-limited, signed out, gh missing), is unverified with one reason: the
// caller then verifies as it did before.
package remoteci

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const (
	StatusVerified   = "verified"
	StatusPending    = "pending"
	StatusUnverified = "unverified"

	runsPerPage = "100"
)

// The reasons a result is not used. The code is also the key of its sentence (server.mission.build.github.<code>).
const (
	ReasonBadSha           = "badSha"
	ReasonNoRepo           = "noRepo"
	ReasonNoGh             = "noGh"
	ReasonLoggedOut        = "loggedOut"
	ReasonRateLimited      = "rateLimited"
	ReasonUnreachable      = "unreachable"
	ReasonNoRun            = "noRun"
	ReasonPartialOnly      = "partialOnly"
	ReasonFailed           = "failed"
	ReasonCancelled        = "cancelled"
	ReasonNoRequired       = "noRequired"
	ReasonRulesUnreadable  = "rulesUnreadable"
	ReasonJobsUnreadable   = "jobsUnreadable"
	ReasonRequiredMissing  = "requiredMissing"
	ReasonRequiredSkipped  = "requiredSkipped"
	ReasonRequiredNotGreen = "requiredNotGreen"
)

// The events whose runs are the full suites: what a push to the trunk, a manual dispatch or a schedule starts. A pull
// request's run tests the merge of its head, often only what its change affects.
var fullSuiteEvents = map[string]bool{"push": true, "workflow_dispatch": true, "schedule": true}

var shaRegex = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Gh runs gh with the repository already named in its arguments: "{owner}/{repo}" in an api path is the project's
// repository (the caller resolves it from origin, so gh never picks a remote by itself).
type Gh func(ctx context.Context, args ...string) ([]byte, error)

type Query struct {
	// The project's repository as "owner/repo", read from origin.
	Repo string
	// The full commit id.
	Sha string
	// The branches whose runs count: the trunk and the release branch.
	Branches []string
	// The workflow file ("ci.yml") when the caller names the one workflow that must be green; empty for any workflow.
	Workflow string
}

type Reason struct {
	Code string
	Vars map[string]string
}

func makeReason(code string, pairs ...string) Reason {
	rtn := Reason{Code: code, Vars: map[string]string{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		rtn.Vars[pairs[i]] = pairs[i+1]
	}
	return rtn
}

// Describe is the reason in English (logs, `molten` output) and as the code a window words in the interface language.
func (r Reason) Describe() (string, *uimsg.Text) {
	v := r.Vars
	switch r.Code {
	case ReasonBadSha:
		return "the commit is not a full commit id", uimsg.Make("mission.build.github.badSha")
	case ReasonNoRepo:
		return "origin is not a GitHub repository", uimsg.Make("mission.build.github.noRepo")
	case ReasonNoGh:
		return "gh is not installed", uimsg.Make("mission.build.github.noGh")
	case ReasonLoggedOut:
		return "you are not signed in to GitHub (gh auth login)", uimsg.Make("mission.build.github.loggedOut")
	case ReasonRateLimited:
		return "GitHub's rate limit is reached", uimsg.Make("mission.build.github.rateLimited")
	case ReasonUnreachable:
		return "GitHub could not be reached", uimsg.Make("mission.build.github.unreachable")
	case ReasonNoRun:
		return fmt.Sprintf("GitHub has no CI run on %s", v["sha"]), uimsg.Make("mission.build.github.noRun", "sha", v["sha"])
	case ReasonPartialOnly:
		return fmt.Sprintf("GitHub's runs on %s are not the full suites (pull request runs, or runs of other branches)", v["sha"]),
			uimsg.Make("mission.build.github.partialOnly", "sha", v["sha"])
	case ReasonFailed:
		return fmt.Sprintf("GitHub's CI run %s ended in %s on %s", v["run"], v["conclusion"], v["sha"]),
			uimsg.Make("mission.build.github.failed", "run", v["run"], "conclusion", v["conclusion"], "sha", v["sha"])
	case ReasonCancelled:
		return fmt.Sprintf("GitHub's CI run %s was cancelled on %s", v["run"], v["sha"]),
			uimsg.Make("mission.build.github.cancelled", "run", v["run"], "sha", v["sha"])
	case ReasonNoRequired:
		return fmt.Sprintf("%s declares no required check, so no GitHub run can stand for its full CI", v["branch"]),
			uimsg.Make("mission.build.github.noRequired", "branch", v["branch"])
	case ReasonRulesUnreadable:
		return fmt.Sprintf("the checks %s requires could not be read", v["branch"]),
			uimsg.Make("mission.build.github.rulesUnreadable", "branch", v["branch"])
	case ReasonJobsUnreadable:
		return fmt.Sprintf("the jobs of GitHub's run %s could not be read", v["run"]),
			uimsg.Make("mission.build.github.jobsUnreadable", "run", v["run"])
	case ReasonRequiredMissing:
		return fmt.Sprintf("the required check %s is not a job of GitHub's run %s", v["check"], v["run"]),
			uimsg.Make("mission.build.github.requiredMissing", "check", v["check"], "run", v["run"])
	case ReasonRequiredSkipped:
		return fmt.Sprintf("the required check %s was skipped in GitHub's run %s", v["check"], v["run"]),
			uimsg.Make("mission.build.github.requiredSkipped", "check", v["check"], "run", v["run"])
	case ReasonRequiredNotGreen:
		return fmt.Sprintf("the required check %s ended in %s in GitHub's run %s", v["check"], v["conclusion"], v["run"]),
			uimsg.Make("mission.build.github.requiredNotGreen", "check", v["check"], "conclusion", v["conclusion"], "run", v["run"])
	}
	return "GitHub's result could not be used", uimsg.Make("mission.build.github.unreachable")
}

type Answer struct {
	Status string
	// Why a result is not used, when Status is unverified.
	Reason Reason
	Sha    string
	// The run that verified the commit, is still going, or ended badly.
	RunId int64
	Url   string
	// Verified: the jobs of the run that concluded success.
	Jobs int
	// Pending: the jobs ended and the jobs of the run, and what changes while the run makes progress.
	JobsDone  int
	JobsTotal int
	Progress  string
}

func unverified(sha string, reason Reason) Answer {
	return Answer{Status: StatusUnverified, Reason: reason, Sha: sha}
}

type apiRepo struct {
	FullName string `json:"full_name"`
}

type apiRun struct {
	Id             int64   `json:"id"`
	Event          string  `json:"event"`
	Status         string  `json:"status"`
	Conclusion     string  `json:"conclusion"`
	HeadSha        string  `json:"head_sha"`
	HeadBranch     string  `json:"head_branch"`
	HtmlUrl        string  `json:"html_url"`
	UpdatedAt      string  `json:"updated_at"`
	Repository     apiRepo `json:"repository"`
	HeadRepository apiRepo `json:"head_repository"`
}

type apiRuns struct {
	WorkflowRuns []apiRun `json:"workflow_runs"`
}

type apiJob struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	HeadSha    string `json:"head_sha"`
}

type apiJobs struct {
	TotalCount int      `json:"total_count"`
	Jobs       []apiJob `json:"jobs"`
}

type apiRule struct {
	Type       string `json:"type"`
	Parameters struct {
		RequiredStatusChecks []struct {
			Context string `json:"context"`
		} `json:"required_status_checks"`
	} `json:"parameters"`
}

// ownerRepo is "owner/repo" of a repository reference that may carry a host ("host/owner/repo").
func ownerRepo(repo string) string {
	parts := strings.Split(strings.TrimSpace(repo), "/")
	if len(parts) < 2 || parts[len(parts)-1] == "" || parts[len(parts)-2] == "" {
		return ""
	}
	return parts[len(parts)-2] + "/" + parts[len(parts)-1]
}

// classify says why gh could not answer, from what it said.
func classify(err error) Reason {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "is not installed"):
		return makeReason(ReasonNoGh)
	case strings.Contains(msg, "rate limit") || strings.Contains(msg, "http 429"):
		return makeReason(ReasonRateLimited)
	case strings.Contains(msg, "gh auth login") || strings.Contains(msg, "not logged") || strings.Contains(msg, "authentication") || strings.Contains(msg, "http 401"):
		return makeReason(ReasonLoggedOut)
	}
	return makeReason(ReasonUnreachable)
}

func short(sha string) string {
	return sha[:min(7, len(sha))]
}

func runsPath(q Query) string {
	base := "repos/{owner}/{repo}/actions/runs"
	if q.Workflow != "" {
		base = "repos/{owner}/{repo}/actions/workflows/" + url.PathEscape(q.Workflow) + "/runs"
	}
	return base + "?head_sha=" + q.Sha + "&per_page=" + runsPerPage
}

// Check asks GitHub whether the commit has a green run of the full suites. It never returns an error: a failure is an
// unverified answer with its reason.
func Check(ctx context.Context, gh Gh, q Query) Answer {
	if !shaRegex.MatchString(q.Sha) {
		return unverified(q.Sha, makeReason(ReasonBadSha))
	}
	repo := ownerRepo(q.Repo)
	if repo == "" {
		return unverified(q.Sha, makeReason(ReasonNoRepo))
	}
	out, err := gh(ctx, "api", runsPath(q))
	if err != nil {
		return unverified(q.Sha, classify(err))
	}
	var listed apiRuns
	if json.Unmarshal(out, &listed) != nil {
		return unverified(q.Sha, makeReason(ReasonUnreachable))
	}
	full, partial := fullSuiteRuns(listed.WorkflowRuns, q, repo)
	if len(full) == 0 {
		if partial {
			return unverified(q.Sha, makeReason(ReasonPartialOnly, "sha", short(q.Sha)))
		}
		return unverified(q.Sha, makeReason(ReasonNoRun, "sha", short(q.Sha)))
	}
	sort.SliceStable(full, func(i, j int) bool { return full[i].Id > full[j].Id })
	rules := &requiredCache{gh: gh, repo: repo, byBranch: map[string]requiredResult{}}
	var pending *apiRun
	var failure *Answer
	for i := range full {
		run := full[i]
		switch {
		case run.Status != "completed":
			if pending == nil {
				pending = &full[i]
			}
		case run.Conclusion == "success":
			answer := verifyJobs(ctx, gh, q, run, rules)
			if answer.Status == StatusVerified {
				return answer
			}
			if failure == nil {
				failure = &answer
			}
		default:
			answer := endedBadly(q, run)
			if failure == nil {
				failure = &answer
			}
		}
	}
	if pending != nil {
		return pendingAnswer(ctx, gh, q, *pending)
	}
	if failure == nil {
		return unverified(q.Sha, makeReason(ReasonNoRun, "sha", short(q.Sha)))
	}
	return *failure
}

// fullSuiteRuns keeps the runs that can stand for the full suites: the commit's own, of the project's own repository, of
// a push, a dispatch or a schedule on one of the branches. partial says that some run existed but was none of those.
func fullSuiteRuns(runs []apiRun, q Query, repo string) ([]apiRun, bool) {
	var full []apiRun
	partial := false
	for _, run := range runs {
		if run.HeadSha != q.Sha {
			continue
		}
		if !strings.EqualFold(run.Repository.FullName, repo) || !strings.EqualFold(run.HeadRepository.FullName, repo) {
			partial = true
			continue
		}
		if !fullSuiteEvents[run.Event] || !onBranches(run.HeadBranch, q.Branches) {
			partial = true
			continue
		}
		full = append(full, run)
	}
	return full, partial
}

func onBranches(branch string, branches []string) bool {
	if len(branches) == 0 {
		return true
	}
	for _, b := range branches {
		if b == branch {
			return true
		}
	}
	return false
}

func endedBadly(q Query, run apiRun) Answer {
	answer := unverified(q.Sha, makeReason(ReasonFailed, "run", fmt.Sprint(run.Id), "conclusion", run.Conclusion, "sha", short(q.Sha)))
	if run.Conclusion == "cancelled" {
		answer.Reason = makeReason(ReasonCancelled, "run", fmt.Sprint(run.Id), "sha", short(q.Sha))
	}
	answer.RunId, answer.Url = run.Id, run.HtmlUrl
	return answer
}

type requiredResult struct {
	checks []string
	err    error
}

// requiredCache reads a branch's required checks once per lookup.
type requiredCache struct {
	gh       Gh
	repo     string
	byBranch map[string]requiredResult
}

func (c *requiredCache) of(ctx context.Context, branch string) ([]string, error) {
	if got, ok := c.byBranch[branch]; ok {
		return got.checks, got.err
	}
	checks, err := readRequired(ctx, c.gh, branch)
	c.byBranch[branch] = requiredResult{checks: checks, err: err}
	return checks, err
}

// readRequired reads the required status checks of the rulesets that apply to a branch.
func readRequired(ctx context.Context, gh Gh, branch string) ([]string, error) {
	out, err := gh(ctx, "api", "repos/{owner}/{repo}/rules/branches/"+url.PathEscape(branch))
	if err != nil {
		return nil, err
	}
	var rules []apiRule
	if err := json.Unmarshal(out, &rules); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	checks := []string{}
	for _, rule := range rules {
		if rule.Type != "required_status_checks" {
			continue
		}
		for _, check := range rule.Parameters.RequiredStatusChecks {
			if check.Context != "" && !seen[check.Context] {
				seen[check.Context] = true
				checks = append(checks, check.Context)
			}
		}
	}
	return checks, nil
}

func listJobs(ctx context.Context, gh Gh, runId int64) (apiJobs, error) {
	var jobs apiJobs
	out, err := gh(ctx, "api", fmt.Sprintf("repos/{owner}/{repo}/actions/runs/%d/jobs?filter=latest&per_page=100", runId))
	if err != nil {
		return jobs, err
	}
	if err := json.Unmarshal(out, &jobs); err != nil {
		return jobs, err
	}
	if jobs.TotalCount > len(jobs.Jobs) {
		return jobs, fmt.Errorf("the run has %d jobs, %d were read", jobs.TotalCount, len(jobs.Jobs))
	}
	return jobs, nil
}

// verifyJobs checks a green run against the branch's required checks.
func verifyJobs(ctx context.Context, gh Gh, q Query, run apiRun, rules *requiredCache) Answer {
	runId := fmt.Sprint(run.Id)
	required, err := rules.of(ctx, run.HeadBranch)
	if err != nil {
		answer := unverified(q.Sha, makeReason(ReasonRulesUnreadable, "branch", run.HeadBranch))
		answer.RunId, answer.Url = run.Id, run.HtmlUrl
		return answer
	}
	named := q.Workflow != ""
	if len(required) == 0 && !named {
		answer := unverified(q.Sha, makeReason(ReasonNoRequired, "branch", run.HeadBranch))
		answer.RunId, answer.Url = run.Id, run.HtmlUrl
		return answer
	}
	jobs, err := listJobs(ctx, gh, run.Id)
	if err != nil && len(required) > 0 {
		answer := unverified(q.Sha, makeReason(ReasonJobsUnreadable, "run", runId))
		answer.RunId, answer.Url = run.Id, run.HtmlUrl
		return answer
	}
	byName := map[string]apiJob{}
	green := 0
	for _, job := range jobs.Jobs {
		if job.HeadSha != "" && job.HeadSha != q.Sha {
			continue
		}
		byName[job.Name] = job
		if job.Conclusion == "success" {
			green++
		}
	}
	for _, check := range required {
		job, ok := byName[check]
		reason := Reason{}
		switch {
		case !ok:
			reason = makeReason(ReasonRequiredMissing, "check", check, "run", runId)
		case job.Status == "completed" && job.Conclusion == "skipped":
			reason = makeReason(ReasonRequiredSkipped, "check", check, "run", runId)
		case job.Status != "completed" || job.Conclusion != "success":
			reason = makeReason(ReasonRequiredNotGreen, "check", check, "conclusion", orStatus(job), "run", runId)
		}
		if reason.Code != "" {
			answer := unverified(q.Sha, reason)
			answer.RunId, answer.Url = run.Id, run.HtmlUrl
			return answer
		}
	}
	return Answer{Status: StatusVerified, Sha: q.Sha, RunId: run.Id, Url: run.HtmlUrl, Jobs: green}
}

func orStatus(job apiJob) string {
	if job.Conclusion != "" {
		return job.Conclusion
	}
	return job.Status
}

// pendingAnswer describes a run still going: how many of its jobs ended, and a signature that changes whenever a job
// starts or ends, so a caller can tell a run that makes progress from one that is stuck.
func pendingAnswer(ctx context.Context, gh Gh, q Query, run apiRun) Answer {
	answer := Answer{Status: StatusPending, Sha: q.Sha, RunId: run.Id, Url: run.HtmlUrl, Progress: run.Status + "|" + run.UpdatedAt}
	jobs, err := listJobs(ctx, gh, run.Id)
	if err != nil {
		return answer
	}
	var sb strings.Builder
	sb.WriteString(run.Status + ";")
	for _, job := range jobs.Jobs {
		fmt.Fprintf(&sb, "%s=%s/%s;", job.Name, job.Status, job.Conclusion)
		if job.Status == "completed" {
			answer.JobsDone++
		}
	}
	answer.JobsTotal = len(jobs.Jobs)
	answer.Progress = sb.String()
	return answer
}
