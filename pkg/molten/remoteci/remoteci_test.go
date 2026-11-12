// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package remoteci

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// Every answer comes from a fake gh: no test reaches the real GitHub API (#2277).

const testSha = "69c76398766553063b5bf3f55617cf2ee4fdf714"

type fakeRun struct {
	id         int64
	event      string
	status     string
	conclusion string
	branch     string
	sha        string
	repo       string
	headRepo   string
}

func (r fakeRun) json() string {
	sha, repo, headRepo := r.sha, r.repo, r.headRepo
	if sha == "" {
		sha = testSha
	}
	if repo == "" {
		repo = "acme/app"
	}
	if headRepo == "" {
		headRepo = repo
	}
	return fmt.Sprintf(`{"id":%d,"event":%q,"status":%q,"conclusion":%q,"head_sha":%q,"head_branch":%q,"html_url":"https://github.example/acme/app/actions/runs/%d","updated_at":"2026-11-12T10:00:00Z","repository":{"full_name":%q},"head_repository":{"full_name":%q}}`,
		r.id, r.event, r.status, r.conclusion, sha, r.branch, r.id, repo, headRepo)
}

func pushRun(id int64, conclusion string) fakeRun {
	return fakeRun{id: id, event: "push", status: "completed", conclusion: conclusion, branch: "develop"}
}

type fakeJob struct {
	name       string
	status     string
	conclusion string
}

func jobsJSON(jobs ...fakeJob) string {
	items := make([]string, 0, len(jobs))
	for _, j := range jobs {
		items = append(items, fmt.Sprintf(`{"name":%q,"status":%q,"conclusion":%q,"head_sha":%q}`, j.name, j.status, j.conclusion, testSha))
	}
	return fmt.Sprintf(`{"total_count":%d,"jobs":[%s]}`, len(jobs), strings.Join(items, ","))
}

func done(name string, conclusion string) fakeJob {
	return fakeJob{name: name, status: "completed", conclusion: conclusion}
}

type fakeGh struct {
	lock     sync.Mutex
	runs     []fakeRun
	runsErr  error
	required []string
	rulesErr error
	jobs     map[int64][]fakeJob
	jobsErr  error
	calls    []string
}

func (f *fakeGh) gh(ctx context.Context, args ...string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	path := args[1]
	f.calls = append(f.calls, path)
	switch {
	case strings.Contains(path, "/actions/runs?") || strings.Contains(path, "/actions/workflows/"):
		if f.runsErr != nil {
			return nil, f.runsErr
		}
		items := make([]string, 0, len(f.runs))
		for _, r := range f.runs {
			items = append(items, r.json())
		}
		return []byte(`{"total_count":` + fmt.Sprint(len(items)) + `,"workflow_runs":[` + strings.Join(items, ",") + `]}`), nil
	case strings.Contains(path, "/rules/branches/"):
		if f.rulesErr != nil {
			return nil, f.rulesErr
		}
		if f.required == nil {
			return []byte(`[{"type":"pull_request","parameters":{}}]`), nil
		}
		checks := make([]string, 0, len(f.required))
		for _, c := range f.required {
			checks = append(checks, fmt.Sprintf(`{"context":%q,"integration_id":15368}`, c))
		}
		return []byte(`[{"type":"required_status_checks","parameters":{"required_status_checks":[` + strings.Join(checks, ",") + `]}}]`), nil
	case strings.HasSuffix(strings.SplitN(path, "?", 2)[0], "/jobs"):
		if f.jobsErr != nil {
			return nil, f.jobsErr
		}
		var id int64
		fmt.Sscanf(strings.TrimPrefix(path, "repos/{owner}/{repo}/actions/runs/"), "%d", &id)
		return []byte(jobsJSON(f.jobs[id]...)), nil
	}
	return nil, fmt.Errorf("unexpected gh call: %s", path)
}

func (f *fakeGh) called(part string) int {
	f.lock.Lock()
	defer f.lock.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.Contains(c, part) {
			n++
		}
	}
	return n
}

func query() Query {
	return Query{Repo: "acme/app", Sha: testSha, Branches: []string{"develop", "main"}}
}

func greenFixture() *fakeGh {
	return &fakeGh{
		runs:     []fakeRun{pushRun(100, "success")},
		required: []string{"Required gate"},
		jobs: map[int64][]fakeJob{100: {
			done("Affected tests", "success"), done("Quick checks", "success"), done("Frontend", "success"),
			done("Required gate", "success"), done("Report a failed full run", "skipped"),
		}},
	}
}

func wantReason(t *testing.T, got Answer, code string) {
	t.Helper()
	if got.Status != StatusUnverified || got.Reason.Code != code {
		t.Fatalf("want unverified (%s), got %+v", code, got)
	}
}

// Acceptance 1: a commit with a green full run, whose required check is green, is verified without a local run.
func TestAGreenFullRunVerifiesTheCommit(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	got := Check(context.Background(), f.gh, query())
	if got.Status != StatusVerified || got.RunId != 100 || got.Jobs != 4 || got.Url != "https://github.example/acme/app/actions/runs/100" {
		t.Fatalf("a green full run verifies the commit: %+v", got)
	}
	if f.called("head_sha="+testSha) != 1 {
		t.Fatalf("the runs are asked for the exact commit: %v", f.calls)
	}
}

// Acceptance 2: a draft's or affected-only run (a pull request's), a run of another repository or branch, and a missing
// run are not the full suites.
func TestOnlyTheFullSuitesCount(t *testing.T) {
	t.Parallel()
	pr := fakeRun{id: 7, event: "pull_request", status: "completed", conclusion: "success", branch: "feature/1-x"}
	cases := []struct {
		name string
		runs []fakeRun
		want string
	}{
		{"no run", nil, ReasonNoRun},
		{"a pull request run", []fakeRun{pr}, ReasonPartialOnly},
		{"a pull request run on the trunk's name", []fakeRun{{id: 8, event: "pull_request", status: "completed", conclusion: "success", branch: "develop"}}, ReasonPartialOnly},
		{"a run of a fork", []fakeRun{{id: 9, event: "push", status: "completed", conclusion: "success", branch: "develop", headRepo: "mallory/app"}}, ReasonPartialOnly},
		{"a run of another repository", []fakeRun{{id: 10, event: "push", status: "completed", conclusion: "success", branch: "develop", repo: "wave/app", headRepo: "wave/app"}}, ReasonPartialOnly},
		{"a push to a feature branch", []fakeRun{{id: 11, event: "push", status: "completed", conclusion: "success", branch: "feature/1-x"}}, ReasonPartialOnly},
		{"a run of another commit", []fakeRun{{id: 12, event: "push", status: "completed", conclusion: "success", branch: "develop", sha: strings.Repeat("a", 40)}}, ReasonNoRun},
	}
	for _, c := range cases {
		f := greenFixture()
		f.runs = c.runs
		if got := Check(context.Background(), f.gh, query()); got.Status != StatusUnverified || got.Reason.Code != c.want {
			t.Errorf("%s: %+v", c.name, got)
		}
		if f.called("/jobs") != 0 {
			t.Errorf("%s: the jobs of a run that does not count are never read", c.name)
		}
	}
}

// The events that start the full suites on the trunk all count: a push, a manual dispatch, the nightly schedule.
func TestPushDispatchAndScheduleRunsCount(t *testing.T) {
	t.Parallel()
	for _, event := range []string{"push", "workflow_dispatch", "schedule"} {
		f := greenFixture()
		f.runs = []fakeRun{{id: 100, event: event, status: "completed", conclusion: "success", branch: "develop"}}
		if got := Check(context.Background(), f.gh, query()); got.Status != StatusVerified {
			t.Errorf("%s: %+v", event, got)
		}
	}
}

// Acceptance 3: a required job skipped, missing or failed in a run that concluded success is not green.
func TestARequiredJobThatDidNotSucceedDoesNotCount(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		jobs []fakeJob
		want string
	}{
		{"skipped", []fakeJob{done("Frontend", "success"), done("Required gate", "skipped")}, ReasonRequiredSkipped},
		{"missing", []fakeJob{done("Frontend", "success")}, ReasonRequiredMissing},
		{"failed", []fakeJob{done("Required gate", "failure")}, ReasonRequiredNotGreen},
		{"still running", []fakeJob{{name: "Required gate", status: "in_progress"}}, ReasonRequiredNotGreen},
	}
	for _, c := range cases {
		f := greenFixture()
		f.jobs[100] = c.jobs
		got := Check(context.Background(), f.gh, query())
		wantReason(t, got, c.want)
		if got.RunId != 100 || got.Reason.Vars["check"] != "Required gate" {
			t.Errorf("%s: the reason names the run and the check: %+v", c.name, got)
		}
	}
}

func TestEveryRequiredCheckMustBeGreen(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.required = []string{"Required gate", "Frontend", "Backend"}
	f.jobs[100] = []fakeJob{done("Required gate", "success"), done("Frontend", "success"), done("Backend", "skipped")}
	got := Check(context.Background(), f.gh, query())
	wantReason(t, got, ReasonRequiredSkipped)
	if got.Reason.Vars["check"] != "Backend" {
		t.Fatalf("the skipped one is named: %+v", got)
	}
}

// A branch with no required check cannot tell its CI from any other workflow, so it accepts no run; a caller that names
// the workflow takes that workflow's own conclusion.
func TestNoRequiredCheckAcceptsNoRunUnlessTheWorkflowIsNamed(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.required = nil
	wantReason(t, Check(context.Background(), f.gh, query()), ReasonNoRequired)
	named := query()
	named.Workflow = "ci.yml"
	got := Check(context.Background(), f.gh, named)
	if got.Status != StatusVerified || got.RunId != 100 {
		t.Fatalf("a named workflow's green run is enough: %+v", got)
	}
	if f.called("/actions/workflows/ci.yml/runs?") != 1 {
		t.Fatalf("a named workflow's runs are asked of that workflow: %v", f.calls)
	}
}

func TestUnreadableRulesAndJobsAreNeverGreen(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.rulesErr = errors.New("gh: HTTP 404: Not Found")
	wantReason(t, Check(context.Background(), f.gh, query()), ReasonRulesUnreadable)
	f = greenFixture()
	f.jobsErr = errors.New("gh: HTTP 502")
	wantReason(t, Check(context.Background(), f.gh, query()), ReasonJobsUnreadable)
}

// Acceptance 2: a failed or cancelled run falls back, and says which run.
func TestAFailedOrCancelledRunFallsBack(t *testing.T) {
	t.Parallel()
	for conclusion, want := range map[string]string{"failure": ReasonFailed, "timed_out": ReasonFailed, "cancelled": ReasonCancelled} {
		f := greenFixture()
		f.runs = []fakeRun{pushRun(55, conclusion)}
		got := Check(context.Background(), f.gh, query())
		wantReason(t, got, want)
		if got.RunId != 55 || got.Url == "" {
			t.Errorf("%s: %+v", conclusion, got)
		}
	}
}

// A run that failed and was run again: the newest success counts, and an older failure is no reason against it.
func TestAGreenRunAmongFailedOnesVerifies(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.runs = []fakeRun{pushRun(100, "success"), pushRun(90, "failure")}
	if got := Check(context.Background(), f.gh, query()); got.Status != StatusVerified || got.RunId != 100 {
		t.Fatalf("%+v", got)
	}
	f.runs = []fakeRun{pushRun(90, "failure"), pushRun(100, "success")}
	f.jobs[90] = f.jobs[100]
	if got := Check(context.Background(), f.gh, query()); got.Status != StatusVerified || got.RunId != 100 {
		t.Fatalf("the order GitHub lists them in does not matter: %+v", got)
	}
}

func TestARunInProgressIsPendingWithItsProgress(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.runs = []fakeRun{{id: 200, event: "push", status: "in_progress", branch: "develop"}}
	f.jobs[200] = []fakeJob{done("Quick checks", "success"), {name: "Frontend", status: "in_progress"}, {name: "Required gate", status: "queued"}}
	first := Check(context.Background(), f.gh, query())
	if first.Status != StatusPending || first.RunId != 200 || first.JobsDone != 1 || first.JobsTotal != 3 || first.Progress == "" {
		t.Fatalf("a run in progress is pending: %+v", first)
	}
	f.jobs[200] = []fakeJob{done("Quick checks", "success"), done("Frontend", "success"), {name: "Required gate", status: "in_progress"}}
	second := Check(context.Background(), f.gh, query())
	if second.JobsDone != 2 || second.Progress == first.Progress {
		t.Fatalf("a job that ended changes the progress: %+v then %+v", first, second)
	}
	if again := Check(context.Background(), f.gh, query()); again.Progress != second.Progress {
		t.Fatalf("nothing happened, the progress is the same: %q then %q", second.Progress, again.Progress)
	}
}

func TestAnEarlierGreenRunBeatsALaterOneInProgress(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.runs = []fakeRun{{id: 200, event: "push", status: "queued", branch: "develop"}, pushRun(100, "success")}
	if got := Check(context.Background(), f.gh, query()); got.Status != StatusVerified || got.RunId != 100 {
		t.Fatalf("a commit already verified is not waited on: %+v", got)
	}
}

// Acceptance 4: offline, rate-limited, signed out, no gh, no GitHub repository: a reason each, never an error.
func TestEveryFailureToAskIsAReason(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"gh is not installed (or not on the login shell's PATH)":                            ReasonNoGh,
		"gh api: HTTP 403: API rate limit exceeded for user":                                ReasonRateLimited,
		"gh api: HTTP 429: too many requests":                                               ReasonRateLimited,
		"To get started with GitHub CLI, please run:  gh auth login":                        ReasonLoggedOut,
		"gh api: HTTP 401: Requires authentication":                                         ReasonLoggedOut,
		"error connecting to api.github.com: dial tcp: lookup api.github.com: no such host": ReasonUnreachable,
	}
	for message, want := range cases {
		f := greenFixture()
		f.runsErr = errors.New(message)
		wantReason(t, Check(context.Background(), f.gh, query()), want)
	}
	f := greenFixture()
	f.runsErr = errors.New("x")
	bad := query()
	bad.Repo = ""
	wantReason(t, Check(context.Background(), f.gh, bad), ReasonNoRepo)
	bad = query()
	bad.Sha = "main"
	wantReason(t, Check(context.Background(), f.gh, bad), ReasonBadSha)
	if f.called("actions") != 0 {
		t.Fatalf("nothing is asked for a commit or a repository that is not one: %v", f.calls)
	}
}

func TestARepositoryOnAnotherHostIsCheckedByItsOwnerAndName(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	q := query()
	q.Repo = "ghe.example/ACME/App"
	if got := Check(context.Background(), f.gh, q); got.Status != StatusVerified {
		t.Fatalf("the host is not part of the comparison, the case is not: %+v", got)
	}
}

func TestARequiredCheckIsReadForTheBranchOfTheRun(t *testing.T) {
	t.Parallel()
	f := greenFixture()
	f.runs = []fakeRun{{id: 100, event: "push", status: "completed", conclusion: "success", branch: "release/1.x"}}
	q := query()
	q.Branches = []string{"release/1.x"}
	if got := Check(context.Background(), f.gh, q); got.Status != StatusVerified {
		t.Fatalf("%+v", got)
	}
	if f.called("rules/branches/release%2F1.x") != 1 {
		t.Fatalf("the branch's name is escaped in the path: %v", f.calls)
	}
}

// Every reason has its English and its code for the windows; the codes are checked against the locales by pkg/molten/uimsg.
func TestEveryReasonHasItsSentence(t *testing.T) {
	t.Parallel()
	codes := []string{ReasonBadSha, ReasonNoRepo, ReasonNoGh, ReasonLoggedOut, ReasonRateLimited, ReasonUnreachable, ReasonNoRun,
		ReasonPartialOnly, ReasonFailed, ReasonCancelled, ReasonNoRequired, ReasonRulesUnreadable, ReasonJobsUnreadable,
		ReasonRequiredMissing, ReasonRequiredSkipped, ReasonRequiredNotGreen}
	for _, code := range codes {
		english, text := makeReason(code, "sha", "69c7639", "run", "7", "check", "Gate", "conclusion", "failure", "branch", "develop").Describe()
		if english == "" || text == nil || text.Code != "mission.build.github."+code {
			t.Errorf("%s: %q %+v", code, english, text)
		}
		if strings.Contains(english, "%!") {
			t.Errorf("%s: the sentence is not filled: %q", code, english)
		}
	}
}
