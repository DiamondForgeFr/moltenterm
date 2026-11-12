// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// A commit already verified is never verified again (#2277): a build's Verify phase reuses a green GitHub run of the
// exact commit and runs the local CI only when there is none to use. Every answer of GitHub is a fake: no test reaches
// the real API, and the repository is a synthetic one.

type ghState struct {
	// The runs of the commit, as the API lists them (JSON objects), and the jobs of each by run id.
	runs     []string
	jobs     map[int64]string
	required []string
	// Answers the runs endpoint with this error.
	err error
}

type fakeGithub struct {
	lock   sync.Mutex
	sha    string
	states []ghState
	cur    int
	calls  []string
	// Called with each look at the runs, to move a test's clock.
	onRuns func(n int)
	asked  int
}

func (f *fakeGithub) state() ghState {
	return f.states[min(f.cur, len(f.states)-1)]
}

func (f *fakeGithub) answer(args []string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	path := args[1]
	f.calls = append(f.calls, strings.Join(args, " "))
	// Each look at the runs moves on to the next state; the calls that follow it, for its jobs, read the same one.
	if strings.Contains(path, "/actions/runs?") {
		if f.asked > 0 && f.cur < len(f.states)-1 {
			f.cur++
		}
		f.asked++
	}
	st := f.state()
	switch {
	case strings.Contains(path, "/actions/runs?"):
		if f.onRuns != nil {
			f.onRuns(f.asked)
		}
		if st.err != nil {
			return nil, st.err
		}
		return []byte(`{"workflow_runs":[` + strings.Join(st.runs, ",") + `]}`), nil
	case strings.Contains(path, "/rules/branches/"):
		checks := make([]string, 0, len(st.required))
		for _, c := range st.required {
			checks = append(checks, fmt.Sprintf(`{"context":%q}`, c))
		}
		return []byte(`[{"type":"required_status_checks","parameters":{"required_status_checks":[` + strings.Join(checks, ",") + `]}}]`), nil
	case strings.Contains(path, "/jobs"):
		var id int64
		fmt.Sscanf(strings.TrimPrefix(path, "repos/acme/app/actions/runs/"), "%d", &id)
		return []byte(st.jobs[id]), nil
	}
	return nil, fmt.Errorf("unexpected gh call: %s", strings.Join(args, " "))
}

func (f *fakeGithub) called(part string) int {
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

func (f *fakeGithub) run(id int64, event string, status string, conclusion string) string {
	return fmt.Sprintf(`{"id":%d,"event":%q,"status":%q,"conclusion":%q,"head_sha":%q,"head_branch":"develop","html_url":"https://github.example/acme/app/actions/runs/%d","updated_at":"2026-11-12T10:00:00Z","repository":{"full_name":"acme/app"},"head_repository":{"full_name":"acme/app"}}`,
		id, event, status, conclusion, f.sha, id)
}

func (f *fakeGithub) jobs(jobs ...[3]string) string {
	items := make([]string, 0, len(jobs))
	for _, j := range jobs {
		items = append(items, fmt.Sprintf(`{"name":%q,"status":%q,"conclusion":%q,"head_sha":%q}`, j[0], j[1], j[2], f.sha))
	}
	return fmt.Sprintf(`{"total_count":%d,"jobs":[%s]}`, len(items), strings.Join(items, ","))
}

// A green full run: three jobs green and the required one among them.
func (f *fakeGithub) green() ghState {
	return ghState{
		runs:     []string{f.run(4242, "push", "completed", "success")},
		required: []string{"Required gate"},
		jobs: map[int64]string{4242: f.jobs([3]string{"Quick checks", "completed", "success"}, [3]string{"Frontend", "completed", "success"},
			[3]string{"Required gate", "completed", "success"}, [3]string{"Report", "completed", "skipped"})},
	}
}

type githubBuild struct {
	r      *Runs
	dir    string
	data   string
	mark   string
	gh     *fakeGithub
	origin *string
	// Every record the build published, in order.
	lock      sync.Mutex
	published []RunRecord
}

func (g *githubBuild) seen(match func(RunRecord) bool) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	for _, rec := range g.published {
		if match(rec) {
			return true
		}
	}
	return false
}

func waitUntil(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(testPoll)
	}
	t.Fatalf("%s did not happen", what)
}

// makeGithubBuild is a project whose gold build verifies with verify, whose single local CI job leaves a mark when it
// runs, and whose origin is acme/app on a GitHub that answers as the fake does.
func makeGithubBuild(t *testing.T, verify string) *githubBuild {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	g := &githubBuild{dir: dir, mark: filepath.Join(t.TempDir(), "local-ci-ran")}
	pipeline := `{"schema":1,"name":"P","ci":{"jobs":[{"name":"check","run":` + jsonString("touch "+g.mark) + `}]},
		"builds":[{"id":"gold","kind":"gold","verify":` + jsonString(verify) + `,"run":"echo '▶ phase: build'"}]}`
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(pipeline), 0644)
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	g.gh = &fakeGithub{sha: gitIn(t, dir, "rev-parse", "HEAD")}
	g.gh.states = []ghState{g.gh.green()}
	origin := "https://github.com/acme/app.git"
	g.origin = &origin
	g.data = t.TempDir()
	trust := MakeTrustStore(filepath.Join(g.data, TrustFileName))
	g.r = makeTestRuns(filepath.Join(g.data, "runs"), trust, func(rec RunRecord) {
		g.lock.Lock()
		defer g.lock.Unlock()
		g.published = append(g.published, rec)
	})
	t.Cleanup(func() { waitRunsIdle(t, g.r) })
	g.r.git = func(ctx context.Context, where string, name string, args ...string) ([]byte, error) {
		switch {
		case name == "gh":
			return g.gh.answer(args)
		case name == "git" && len(args) >= 3 && args[0] == "remote" && args[1] == "get-url":
			return []byte(*g.origin + "\n"), nil
		case name == "git" && len(args) > 0 && args[0] == "fetch":
			return nil, nil
		}
		return plainRunner(ctx, where, name, args...)
	}
	g.r.UseCi(MakeCi(filepath.Join(g.data, "ci"), trust, withoutGh, nil))
	return g
}

func (g *githubBuild) start(t *testing.T) RunRecord {
	t.Helper()
	return trustAndStart(t, g.r, g.dir, "gold")
}

func (g *githubBuild) localCiRan() bool {
	_, err := os.Stat(g.mark)
	return err == nil
}

func (g *githubBuild) log(t *testing.T, rec RunRecord) string {
	t.Helper()
	return buildLogText(t, g.data, rec.Id)
}

// Acceptance 1: a commit with a green full GitHub run is verified in seconds, the log and the record name the run, and
// nothing runs locally.
func TestBuildIsVerifiedByAGreenGithubRun(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	built := waitRun(t, g.r, g.dir, g.start(t).Id)
	short := g.gh.sha[:7]
	log := g.log(t, built)
	if built.State != RunStateSuccess || strings.Join(built.Phases, ",") != "verify,build" {
		t.Fatalf("a commit GitHub verified builds at once: %+v\n%s", built, log)
	}
	want := "Verified by GitHub CI · run 4242 · 3 jobs green on " + short
	if !strings.Contains(log, want) || !strings.Contains(log, "https://github.example/acme/app/actions/runs/4242") {
		t.Fatalf("the log names the run and links it:\n%s", log)
	}
	v := built.Verify
	if v == nil || v.By != VerifyByGithub || v.RunId != 4242 || v.Jobs != 3 || v.Sha != short || v.Url == "" {
		t.Fatalf("the record says how the commit was verified: %+v", v)
	}
	if g.localCiRan() || strings.Contains(log, "local CI") {
		t.Fatalf("nothing runs locally for a commit GitHub verified:\n%s", log)
	}
	if entries, _ := filepath.Glob(filepath.Join(g.data, "ci", "*", "runs", "*")); len(entries) != 0 {
		t.Fatalf("no local CI run was recorded: %v", entries)
	}
}

// GitHub is asked for the exact commit, in the repository origin names, never a branch and never the one gh would pick.
func TestBuildAsksGithubForTheExactCommitOfItsOwnRepository(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	waitRun(t, g.r, g.dir, g.start(t).Id)
	if g.gh.called("api repos/acme/app/actions/runs?head_sha="+g.gh.sha+"&per_page=100") != 1 || g.gh.called("rules/branches/develop") != 1 {
		t.Fatalf("calls: %v", g.gh.calls)
	}
	for _, call := range g.gh.calls {
		if strings.Contains(call, "{owner}") || strings.Contains(call, "{repo}") {
			t.Fatalf("gh was left to find the repository by itself: %s", call)
		}
	}
}

// Acceptances 2, 3 and 4: whatever is not a green run of the full suites runs the local CI as before, after a line that
// says why.
func TestBuildFallsBackToTheLocalCiWithOneReason(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		setup func(g *githubBuild)
		code  string
		line  string
	}{
		{"no run on the commit", func(g *githubBuild) { g.gh.states = []ghState{{}} }, "mission.build.github.noRun", "GitHub has no CI run on"},
		{"a draft's pull request run", func(g *githubBuild) {
			g.gh.states = []ghState{{runs: []string{g.gh.run(7, "pull_request", "completed", "success")}}}
		}, "mission.build.github.partialOnly", "are not the full suites"},
		{"a failed run", func(g *githubBuild) {
			g.gh.states = []ghState{{runs: []string{g.gh.run(8, "push", "completed", "failure")}}}
		}, "mission.build.github.failed", "ended in failure"},
		{"a cancelled run", func(g *githubBuild) {
			g.gh.states = []ghState{{runs: []string{g.gh.run(9, "push", "completed", "cancelled")}}}
		}, "mission.build.github.cancelled", "was cancelled"},
		{"a required job skipped", func(g *githubBuild) {
			st := g.gh.green()
			st.jobs[4242] = g.gh.jobs([3]string{"Required gate", "completed", "skipped"})
			g.gh.states = []ghState{st}
		}, "mission.build.github.requiredSkipped", "was skipped"},
		{"no required check declared", func(g *githubBuild) {
			st := g.gh.green()
			st.required = nil
			g.gh.states = []ghState{st}
		}, "mission.build.github.noRequired", "declares no required check"},
		{"not signed in", func(g *githubBuild) {
			g.gh.states = []ghState{{err: errors.New("gh api repos/acme/app/actions/runs: To get started with GitHub CLI, please run:  gh auth login")}}
		}, "mission.build.github.loggedOut", "not signed in to GitHub"},
		{"offline", func(g *githubBuild) {
			g.gh.states = []ghState{{err: errors.New("gh api: error connecting to api.github.com")}}
		}, "mission.build.github.unreachable", "GitHub could not be reached"},
		{"rate limited", func(g *githubBuild) {
			g.gh.states = []ghState{{err: errors.New("gh api: HTTP 403: API rate limit exceeded")}}
		}, "mission.build.github.rateLimited", "rate limit"},
		{"origin not on GitHub", func(g *githubBuild) { *g.origin = "/srv/git/app.git" }, "mission.build.github.noRepo", "not a GitHub repository"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			g := makeGithubBuild(t, "ci")
			c.setup(g)
			built := waitRun(t, g.r, g.dir, g.start(t).Id)
			log := g.log(t, built)
			if built.State != RunStateSuccess || !g.localCiRan() {
				t.Fatalf("the local CI verifies as before: %+v\n%s", built, log)
			}
			v := built.Verify
			if v == nil || v.By != VerifyByLocal || v.WhyText == nil || v.WhyText.Code != c.code || !strings.Contains(v.Why, c.line) {
				t.Fatalf("the record says why GitHub's result was not used: %+v", v)
			}
			if !strings.Contains(log, "GitHub CI not used: "+v.Why+". Verifying with the local CI.") {
				t.Fatalf("the log says why in one line:\n%s", log)
			}
		})
	}
}

// A pipeline can opt out: verify "ci-local" never asks GitHub.
func TestBuildThatOptsOutNeverAsksGithub(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci-local")
	built := waitRun(t, g.r, g.dir, g.start(t).Id)
	if built.State != RunStateSuccess || !g.localCiRan() || len(g.gh.calls) != 0 {
		t.Fatalf("the local CI always verifies: %+v, gh asked %v", built, g.gh.calls)
	}
	if v := built.Verify; v == nil || v.By != VerifyByLocal || v.WhyText == nil || v.WhyText.Code != "mission.build.github.localChosen" {
		t.Fatalf("the record says the pipeline chose it: %+v", v)
	}
}

// A run in progress is waited for while its jobs make progress, then the commit is verified without a local run.
func TestBuildWaitsForARunInProgress(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	running := func(done int) ghState {
		jobs := [][3]string{{"Quick checks", "completed", "success"}, {"Frontend", "in_progress", ""}, {"Required gate", "queued", ""}}
		if done == 2 {
			jobs[1] = [3]string{"Frontend", "completed", "success"}
		}
		return ghState{
			runs:     []string{g.gh.run(4242, "push", "in_progress", "")},
			required: []string{"Required gate"},
			jobs:     map[int64]string{4242: g.gh.jobs(jobs...)},
		}
	}
	g.gh.states = []ghState{running(1), running(1), running(2), g.gh.green()}
	built := waitRun(t, g.r, g.dir, g.start(t).Id)
	log := g.log(t, built)
	if built.State != RunStateSuccess || g.localCiRan() || built.Verify == nil || built.Verify.By != VerifyByGithub {
		t.Fatalf("the green run ends the wait: %+v\n%s", built, log)
	}
	if !g.seen(func(rec RunRecord) bool {
		return rec.Verify != nil && rec.Verify.By == VerifyByWaiting && rec.Verify.RunId == 4242 && rec.Verify.Done == 1 && rec.Verify.Total == 3
	}) || !g.seen(func(rec RunRecord) bool { return rec.Verify != nil && rec.Verify.By == VerifyByWaiting && rec.Verify.Done == 2 }) {
		t.Fatalf("the row followed the run's jobs")
	}
	if !strings.Contains(log, "GitHub CI run 4242 is still going") {
		t.Fatalf("the log says it waits:\n%s", log)
	}
}

// "Verify here instead" ends the wait at once and the local CI runs.
func TestVerifyHereInsteadRunsTheLocalCi(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	g.gh.states = []ghState{{runs: []string{g.gh.run(4242, "push", "in_progress", "")}, required: []string{"Required gate"},
		jobs: map[int64]string{4242: g.gh.jobs([3]string{"Required gate", "in_progress", ""})}}}
	started := g.start(t)
	waitUntil(t, "the build waiting", func() bool {
		return g.seen(func(rec RunRecord) bool { return rec.Verify != nil && rec.Verify.By == VerifyByWaiting })
	})
	if err := g.r.VerifyHere(g.dir, started.Id); err != nil {
		t.Fatal(err)
	}
	built := waitRun(t, g.r, g.dir, started.Id)
	if built.State != RunStateSuccess || !g.localCiRan() {
		t.Fatalf("the local CI verifies once the developer chose it: %+v\n%s", built, g.log(t, built))
	}
	if err := g.r.VerifyHere(g.dir, started.Id); err == nil {
		t.Fatal("a build that no longer waits for GitHub has nothing to stop waiting for")
	}
	if v := built.Verify; v == nil || v.By != VerifyByLocal || v.WhyText == nil || v.WhyText.Code != "mission.build.github.hereChosen" {
		t.Fatalf("the record says the developer chose it: %+v", v)
	}
}

// A run that makes no progress for the stall bound stops being waited for.
func TestBuildStopsWaitingForAStuckGithubRun(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	g.gh.states = []ghState{{runs: []string{g.gh.run(4242, "push", "queued", "")}, required: []string{"Required gate"},
		jobs: map[int64]string{4242: g.gh.jobs([3]string{"Required gate", "queued", ""})}}}
	// Each look at GitHub's runs is 11 minutes later on the build's clock; nothing else moves it.
	var lock sync.Mutex
	base, offset := time.Now(), time.Duration(0)
	g.r.now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		return base.Add(offset)
	}
	g.gh.onRuns = func(int) {
		lock.Lock()
		defer lock.Unlock()
		offset += 11 * time.Minute
	}
	built := waitRun(t, g.r, g.dir, g.start(t).Id)
	if built.State != RunStateSuccess || !g.localCiRan() {
		t.Fatalf("the local CI verifies after the stall: %+v\n%s", built, g.log(t, built))
	}
	if v := built.Verify; v == nil || v.By != VerifyByLocal || v.WhyText == nil || v.WhyText.Code != "mission.build.github.stalled" ||
		v.WhyText.Vars["minutes"] != "10" {
		t.Fatalf("the record says the run stalled: %+v", v)
	}
}

// A cancel while the build waits for GitHub is answered at once, and says it was the developer's.
func TestBuildCancelledWhileWaitingForGithub(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	g.gh.states = []ghState{{runs: []string{g.gh.run(4242, "push", "in_progress", "")}, required: []string{"Required gate"},
		jobs: map[int64]string{4242: g.gh.jobs([3]string{"Required gate", "in_progress", ""})}}}
	started := g.start(t)
	waitUntil(t, "the build waiting", func() bool {
		return g.seen(func(rec RunRecord) bool { return rec.Verify != nil && rec.Verify.By == VerifyByWaiting })
	})
	if err := g.r.Cancel(g.dir, started.Id); err != nil {
		t.Fatal(err)
	}
	cancelled := waitRun(t, g.r, g.dir, started.Id)
	if cancelled.State != RunStateCancelled || cancelled.Stopped != "Cancelled by you." || g.localCiRan() {
		t.Fatalf("a cancel stops the wait and starts nothing: %+v", cancelled)
	}
}

// Acceptance 5: the local CI, started by a build that GitHub could not verify, reuses the jobs already green on the tree.
func TestBuildAfterAGreenLocalRunOfTheSameTreeRunsNoJob(t *testing.T) {
	t.Parallel()
	g := makeGithubBuild(t, "ci")
	g.gh.states = []ghState{{}}
	waitRun(t, g.r, g.dir, g.start(t).Id)
	if !g.localCiRan() {
		t.Fatal("the first build verifies locally")
	}
	os.Remove(g.mark)
	built := waitRun(t, g.r, g.dir, g.start(t).Id)
	if built.State != RunStateSuccess || g.localCiRan() || !strings.Contains(g.log(t, built), "local CI already green on") {
		t.Fatalf("a tree already green locally reruns nothing: %+v\n%s", built, g.log(t, built))
	}
}
