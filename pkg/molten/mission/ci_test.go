// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// A git project whose pipeline declares ci; returns the CI runner, already trusted, and the project folder.
func makeCiFixture(t *testing.T, ci string) (*Ci, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the local CI uses /bin/sh")
	}
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","ci":`+ci+`}`), 0644)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0644)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	data := t.TempDir()
	trust := MakeTrustStore(filepath.Join(data, TrustFileName))
	c := MakeCi(filepath.Join(data, "ci"), trust, plainRunner, nil)
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		t.Fatalf("pipeline: %v", report.Errors)
	}
	if err := trust.Trust(dir, CommandsHash(PipelineCommands(report.Pipeline))); err != nil {
		t.Fatal(err)
	}
	return c, dir
}

func waitCi(t *testing.T, c *Ci, dir string, runId string) CiRunRecord {
	t.Helper()
	// Generous: it only bounds a failing run (#1208).
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if c.activeRun(dir) == nil {
			rec, err := c.readRecord(dir, runId)
			if err != nil {
				t.Fatal(err)
			}
			return rec
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("CI run %s did not finish", runId)
	return CiRunRecord{}
}

func startCi(t *testing.T, c *Ci, dir string, req CiRunRequest) CiRunRecord {
	t.Helper()
	req.Dir = dir
	res, err := c.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Run == nil {
		t.Fatalf("no run started: %+v", res)
	}
	return waitCi(t, c, dir, res.Run.Id)
}

func jobStatuses(rec CiRunRecord) map[string]string {
	rtn := map[string]string{}
	for _, job := range rec.Jobs {
		rtn[job.Name] = job.Status
	}
	return rtn
}

func TestSelectCiJobsAndLanes(t *testing.T) {
	jobs := []molten.PipelineJob{{Name: "check", Lane: "web"}, {Name: "e2e", Lane: "web"}, {Name: "rust", Lane: "rust"}, {Name: "solo"}}
	verdicts := map[string]CiVerdict{"check": {Status: CiStateSuccess}, "e2e": {Status: CiStateFailure}}
	names := func(js []molten.PipelineJob) []string {
		var rtn []string
		for _, j := range js {
			rtn = append(rtn, j.Name)
		}
		return rtn
	}
	if got := names(selectCiJobs(jobs, verdicts, false, nil)); !reflect.DeepEqual(got, []string{"e2e", "rust", "solo"}) {
		t.Fatalf("only what is not green: %v", got)
	}
	if got := names(selectCiJobs(jobs, verdicts, true, nil)); len(got) != 4 {
		t.Fatalf("Run all again: %v", got)
	}
	if got := names(selectCiJobs(jobs, verdicts, false, []string{"check"})); !reflect.DeepEqual(got, []string{"check"}) {
		t.Fatalf("only: %v", got)
	}
	lanes := ciLanes(jobs)
	if len(lanes) != 3 || len(lanes[0]) != 2 || lanes[1][0].Name != "rust" || lanes[2][0].Name != "solo" {
		t.Fatalf("lanes: %+v", lanes)
	}
	if status, failed, missing := codeVerdict(jobs, verdicts); status != CiStateFailure || !reflect.DeepEqual(failed, []string{"e2e"}) || len(missing) != 2 {
		t.Fatalf("verdict: %s %v %v", status, failed, missing)
	}
}

func TestCiRunKeepsVerdictsPerTree(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[
		{"name":"check","lane":"web","run":"echo checking; test -f a.txt"},
		{"name":"e2e","lane":"web","run":"test -f fixed.txt"},
		{"name":"rust","lane":"rust","run":"echo rust"}]}`)
	first := startCi(t, c, dir, CiRunRequest{})
	if first.Status != CiStateFailure || !reflect.DeepEqual(jobStatuses(first), map[string]string{"check": "success", "e2e": "failure", "rust": "success"}) {
		t.Fatalf("first run: %+v", first)
	}
	chunk, err := c.ReadLog(dir, first.Id, "check", 0)
	if err != nil || !strings.Contains(chunk.Text, "checking") {
		t.Fatalf("job log: %+v %v", chunk, err)
	}
	status, err := c.Status(dir, "develop")
	if err != nil || status.Status != CiStateFailure || !reflect.DeepEqual(status.Failed, []string{"e2e"}) {
		t.Fatalf("status: %+v %v", status, err)
	}
	state, err := c.State(dir)
	if err != nil || len(state.Branches) != 1 || state.Branches[0].Verdict != CiStateFailure || state.Current != "develop" {
		t.Fatalf("state: %+v %v", state, err)
	}
	// Fix it; check and rust keep their verdicts only on the same tree, so a new tree runs everything.
	os.WriteFile(filepath.Join(dir, "fixed.txt"), []byte("ok\n"), 0644)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "fix")
	second := startCi(t, c, dir, CiRunRequest{Branch: "develop"})
	if second.Status != CiStateSuccess || len(second.Jobs) != 3 {
		t.Fatalf("second run on new code: %+v", second)
	}
	if _, err := c.Start(CiRunRequest{Dir: dir}); err == nil || !strings.Contains(err.Error(), "already green") {
		t.Fatalf("a green tree has nothing to run: %v", err)
	}
	// The same code on another commit keeps its verdicts.
	gitIn(t, dir, "commit", "-q", "--allow-empty", "-m", "empty")
	if status, _ := c.Status(dir, "HEAD"); status.Status != CiStateSuccess {
		t.Fatalf("same tree, same verdicts: %+v", status)
	}
	forced := startCi(t, c, dir, CiRunRequest{Force: true, Only: []string{"rust"}})
	if !reflect.DeepEqual(jobStatuses(forced), map[string]string{"rust": "success"}) {
		t.Fatalf("only rust: %+v", forced)
	}
}

func TestCiFailedJobStopsItsLane(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[
		{"name":"first","lane":"web","run":"exit 2"},
		{"name":"second","lane":"web","run":"echo never"},
		{"name":"other","lane":"rust","run":"echo other"}]}`)
	rec := startCi(t, c, dir, CiRunRequest{})
	if !reflect.DeepEqual(jobStatuses(rec), map[string]string{"first": "failure", "second": "cancelled", "other": "success"}) {
		t.Fatalf("lane stop: %+v", rec)
	}
	if rec.Jobs[0].Exit == nil || *rec.Jobs[0].Exit != 2 {
		t.Fatalf("exit code kept: %+v", rec.Jobs[0])
	}
}

func TestCiCancelAndPrepare(t *testing.T) {
	c, dir := makeCiFixture(t, `{"prepare":{"run":"echo preparing"},"jobs":[{"name":"slow","run":"sleep 3600"}]}`)
	res, err := c.Start(CiRunRequest{Dir: dir})
	if err != nil || res.Run == nil {
		t.Fatalf("start: %+v %v", res, err)
	}
	if _, err := c.Start(CiRunRequest{Dir: dir, Force: true}); err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Fatalf("one run at a time: %v", err)
	}
	deadline := time.Now().Add(time.Minute)
	for rec, _ := c.readRecord(dir, res.Run.Id); len(rec.Jobs) == 0 || rec.Jobs[0].Status != CiStateRunning; rec, _ = c.readRecord(dir, res.Run.Id) {
		if time.Now().After(deadline) {
			t.Fatal("the slow job never ran")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := c.Cancel(dir, res.Run.Id); err != nil {
		t.Fatal(err)
	}
	rec := waitCi(t, c, dir, res.Run.Id)
	if rec.Status != CiStateCancelled || rec.Jobs[0].Status != CiStateCancelled {
		t.Fatalf("cancelled: %+v", rec)
	}
	prepare, _ := c.ReadLog(dir, rec.Id, "prepare", 0)
	if !strings.Contains(prepare.Text, "preparing") {
		t.Fatalf("prepare log: %q", prepare.Text)
	}
	if status, _ := c.Status(dir, ""); status.Status != CiVerdictMissing {
		t.Fatalf("a cancelled job leaves no verdict: %+v", status)
	}
}

// An agent works in a linked worktree on its own branch: the CI of that branch is started from the project's main
// checkout by naming the branch, and tests the branch's code, not the code checked out in the project folder (#383).
func TestCiRunsABranchCheckedOutInAnotherWorktree(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"feature","run":"test -f b.txt"}]}`)
	worktree := filepath.Join(t.TempDir(), "wt")
	gitIn(t, dir, "worktree", "add", "-q", "-b", "feature/383-x", worktree)
	os.WriteFile(filepath.Join(worktree, "b.txt"), []byte("b\n"), 0644)
	gitIn(t, worktree, "add", "-A")
	gitIn(t, worktree, "commit", "-q", "-m", "add b")

	if status, err := c.Status(dir, "feature/383-x"); err != nil || status.Status != CiVerdictMissing {
		t.Fatalf("status of the branch before the run: %+v %v", status, err)
	}
	rec := startCi(t, c, dir, CiRunRequest{Branch: "feature/383-x"})
	if rec.Status != CiStateSuccess || rec.Branch != "feature/383-x" || rec.Sha != gitIn(t, worktree, "rev-parse", "HEAD") {
		t.Fatalf("the run must test the branch, checked out elsewhere: %+v", rec)
	}
	if status, err := c.Status(dir, "feature/383-x"); err != nil || status.Status != CiStateSuccess {
		t.Fatalf("status of the branch after the run: %+v %v", status, err)
	}
	if status, _ := c.Status(dir, "develop"); status.Status != CiVerdictMissing {
		t.Fatalf("the project's own branch has not run: %+v", status)
	}
}

// #1072: the main checkout is on branch A, a linked worktree on branch B. `molten ci run` with no branch, from the
// worktree, sends the project folder (the main checkout) and the worktree as From: the run must test B's head and
// say so, never the main checkout's HEAD under "no branch".
func TestCiRunWithNoBranchTestsTheCallersWorktree(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"b","run":"test -f b.txt"}]}`)
	gitIn(t, dir, "checkout", "-q", "-b", "fix/1189-a")
	os.WriteFile(filepath.Join(dir, "main.txt"), []byte("a\n"), 0644)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "main checkout")
	worktree := filepath.Join(t.TempDir(), "wt")
	gitIn(t, dir, "worktree", "add", "-q", "-b", "dependabot/b", worktree, "develop")
	os.WriteFile(filepath.Join(worktree, "b.txt"), []byte("b\n"), 0644)
	gitIn(t, worktree, "add", "-A")
	gitIn(t, worktree, "commit", "-q", "-m", "add b")
	headB := gitIn(t, worktree, "rev-parse", "HEAD")

	if status, err := c.StatusFrom(dir, "", worktree); err != nil || status.Sha != headB || status.Status != CiVerdictMissing {
		t.Fatalf("status from the worktree before the run: %+v %v", status, err)
	}
	rec := startCi(t, c, dir, CiRunRequest{From: worktree})
	if rec.Status != CiStateSuccess || rec.Sha != headB || rec.Branch != "dependabot/b" || rec.Detached {
		t.Fatalf("the run must test the worktree's branch B: %+v", rec)
	}
	if status, err := c.StatusFrom(dir, "", worktree); err != nil || status.Status != CiStateSuccess {
		t.Fatalf("status from the worktree after the run: %+v %v", status, err)
	}
	if status, err := c.StatusFrom(dir, "", dir); err != nil || status.Status != CiVerdictMissing || status.Sha == headB {
		t.Fatalf("the main checkout's own HEAD has not run: %+v %v", status, err)
	}

	gitIn(t, worktree, "checkout", "-q", "--detach", "HEAD~1")
	detached := gitIn(t, worktree, "rev-parse", "HEAD")
	res, err := c.Start(CiRunRequest{Dir: dir, From: worktree, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	rec = waitCi(t, c, dir, res.Run.Id)
	if rec.Sha != detached || rec.Branch != "" || !rec.Detached || !reflect.DeepEqual(rec.Heads, []string{"develop"}) {
		t.Fatalf("a detached HEAD runs on its commit, labelled with the branch at it: %+v", rec)
	}
	if got := c.branchOf(rec); got != "develop" {
		t.Fatalf("{branch} of a detached run is the one branch at its commit, not the main checkout's: %q", got)
	}

	rec = startCi(t, c, dir, CiRunRequest{Force: true})
	if rec.Sha != gitIn(t, dir, "rev-parse", "HEAD") || rec.Branch != "fix/1189-a" {
		t.Fatalf("with no From, the project folder's checkout, labelled: %+v", rec)
	}
}

// #1072: a folder of another repository is not a checkout of the project: refused, nothing guessed.
func TestCiRunRefusesACheckoutOfAnotherRepository(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"a","run":"true"}]}`)
	other := t.TempDir()
	gitIn(t, other, "init", "-q", "-b", "develop")
	gitIn(t, other, "commit", "-q", "--allow-empty", "-m", "other")
	for _, from := range []string{other, t.TempDir(), "relative"} {
		if res, err := c.Start(CiRunRequest{Dir: dir, From: from}); err == nil {
			t.Fatalf("from %s: want a refusal, got %+v", from, res)
		}
		if _, err := c.StatusFrom(dir, "", from); err == nil {
			t.Fatalf("status from %s: want a refusal", from)
		}
	}
	if runs := c.runs(dir); len(runs) != 0 {
		t.Fatalf("nothing may run: %+v", runs)
	}
}

func TestCiRunLeftRunningIsInterrupted(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"a","run":"true"}]}`)
	c.writeRecord(CiRunRecord{Id: "20260101-000000-aaaaaa", Dir: dir, Status: CiStateRunning, StartedAt: 1, Jobs: []CiJobRecord{{Name: "a", Status: CiStateRunning}}})
	runs := c.runs(dir)
	if len(runs) != 1 || runs[0].Status != CiStateInterrupted || runs[0].Jobs[0].Status != CiStateInterrupted {
		t.Fatalf("interrupted: %+v", runs)
	}
	if _, err := c.ReadLog(dir, "../x", "a", 0); err == nil {
		t.Fatal("a run id with a path must be refused")
	}
	if _, err := c.ReadLog(dir, "20260101-000000-aaaaaa", "../a", 0); err == nil {
		t.Fatal("a job with a path must be refused")
	}
}
