// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const admissionPipeline = `{"schema":1,"name":"admission","builds":[{"id":"build","run":"echo build"}],"steps":[{"id":"one","title":"First","section":"timeline","run":"echo child >> launches"},{"id":"two","title":"Second","section":"timeline","run":"echo second >> launches"}]}`

func trustAdmission(t *testing.T, r *Runs, dir string) {
	t.Helper()
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		t.Fatalf("invalid fixture: %+v", report)
	}
	if err := r.GrantTrust(dir, CommandsHash(PipelineCommands(report.Pipeline))); err != nil {
		t.Fatal(err)
	}
}

// Hold exactly the first matching lookup. A broken admission lets the contender pass this lookup, so the test
// observes an accepted second request instead of depending on a scheduler delay to reproduce the race.
func holdAdmission(t *testing.T, r *Runs, match string) (<-chan struct{}, func()) {
	t.Helper()
	return holdAdmissionRunner(t, &r.git, match)
}

func holdAdmissionRunner(t *testing.T, runner *Runner, match string) (<-chan struct{}, func()) {
	t.Helper()
	entered, resume := make(chan struct{}), make(chan struct{})
	var seen atomic.Bool
	var once sync.Once
	proceed := func() { once.Do(func() { close(resume) }) }
	*runner = func(ctx context.Context, dir, command string, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), match) && seen.CompareAndSwap(false, true) {
			close(entered)
			select {
			case <-resume:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return plainRunner(ctx, dir, command, args...)
	}
	t.Cleanup(proceed)
	return entered, proceed
}

func TestAdmissionBuildNestedCiKeepsTrustedAliasProject(t *testing.T) {
	for _, retarget := range []bool{false, true} {
		t.Run(map[bool]string{false: "stable", true: "retargeted"}[retarget], func(t *testing.T) {
			pipeline := `{"schema":1,"name":"Pinned A","builds":[{"id":"build","run":"echo built > built.txt","verify":"ci","artifact":"artifact.txt"}],"ci":{"jobs":[{"name":"check","run":"echo ciA > checks"}]}}`
			r, dir := makeReleaseFixture(t, pipeline)
			_, other := makeReleaseFixture(t, strings.ReplaceAll(pipeline, "ciA", "ciB"))
			alias := filepath.Join(t.TempDir(), "project")
			if err := os.Symlink(dir, alias); err != nil {
				t.Fatal(err)
			}
			trustAdmission(t, r, alias)
			ci := MakeCi(filepath.Join(t.TempDir(), "ci"), r.trust, plainRunner, nil)
			r.UseCi(ci)
			entered, proceed := holdAdmissionRunner(t, &ci.run, "rev-parse")
			result, err := r.Start(RunRequest{Dir: alias, Kind: RunKindBuild, Id: "build"})
			if err != nil || result.Run == nil {
				t.Fatalf("build failed to start: %+v, %v", result, err)
			}
			admissionResult(t, entered)
			if retarget {
				if err := os.Remove(alias); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(other, alias); err != nil {
					t.Fatal(err)
				}
			}
			proceed()
			record := waitRun(t, r, dir, result.Run.Id)
			if record.State != RunStateSuccess || record.Dir != alias || record.Artifact != filepath.Join(canonicalRunDir(dir), "artifact.txt") {
				t.Fatalf("pinned build failed or changed presentation/artifact: %+v", record)
			}
			data, err := os.ReadFile(filepath.Join(ci.worktreeDir(alias), "checks"))
			if err != nil || string(data) != "ciA\n" {
				t.Fatalf("CI verified retargeted project: %q, %v", data, err)
			}
			if records := ci.runs(alias); len(records) != 1 || records[0].Dir != alias || records[0].Status != CiStateSuccess {
				t.Fatalf("alias CI history/trust lost: %+v", records)
			}
		})
	}
}

func admissionResult[T any](t *testing.T, results <-chan T) T {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(30 * time.Second):
		t.Fatal("admission did not reach its synchronization point")
		var zero T
		return zero
	}
}

func admissionPoll(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("admission fixture condition was not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// This guard needs #812's post-start cleanup. Keep the failure injection after cmd.Start: a failure before it
// cannot establish that a released admission leaves no live, unrecorded process behind.
func TestAdmissionPostStartRecordFailureCleansChild(t *testing.T) {
	r, dir := makeReleaseFixture(t, `{"schema":1,"name":"fixture","steps":[{"id":"held","title":"Held","section":"timeline","run":"echo $$ > child.pid; touch child.ready; while ! test -f child.done; do sleep 0.02; done"}]}`)
	trustAdmission(t, r, dir)
	var temporary string
	injected := make(chan struct{})
	r.agentEnv = func(string) []string {
		entries, err := os.ReadDir(r.projectDir(dir))
		if err != nil {
			t.Error(err)
			return nil
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			parent := filepath.Join(r.projectDir(dir), entry.Name())
			temporary = filepath.Join(parent, RunFileName+".tmp")
			if out, err := exec.Command("mkfifo", temporary).CombinedOutput(); err != nil {
				t.Errorf("mkfifo: %v %s", err, out)
				return nil
			}
			if err := os.Mkdir(filepath.Join(parent, RunFileName), 0700); err != nil {
				t.Error(err)
				return nil
			}
			close(injected)
			return nil
		}
		t.Error("fixture found no opened run directory")
		return nil
	}
	result := make(chan admittedRun, 1)
	go func() {
		accepted, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "held"})
		result <- admittedRun{accepted, err}
	}()
	admissionResult(t, injected)
	t.Cleanup(func() { os.WriteFile(filepath.Join(dir, "child.done"), nil, 0600) })
	admissionPoll(t, func() bool { _, err := os.Stat(filepath.Join(dir, "child.ready")); return err == nil })
	pidData, err := os.ReadFile(filepath.Join(dir, "child.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil || pid <= 0 {
		t.Fatalf("bad child pid: %q, %v", pidData, err)
	}
	t.Cleanup(func() {
		os.WriteFile(filepath.Join(dir, "child.done"), nil, 0600)
		if child, err := os.FindProcess(pid); err == nil {
			child.Wait()
		}
	})
	// The command is demonstrably alive; allow the record write to finish and fail its rename to the directory.
	if data, err := os.ReadFile(temporary); err != nil || !strings.Contains(string(data), `"pid":`) {
		t.Fatalf("persistence gate failed: %q, %v", data, err)
	}
	failed := admissionResult(t, result)
	r.agentEnv = nil
	if failed.err == nil || failed.result.Run != nil {
		t.Fatalf("failed record accepted: %+v", failed)
	}
	admissionPoll(t, func() bool { return !processAlive(pid) })
	if err := os.Remove(temporary); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(strings.TrimSuffix(temporary, ".tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "child.done"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	retry, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "held"})
	if err != nil || retry.Run == nil {
		t.Fatalf("rollback did not permit retry: %+v, %v", retry, err)
	}
	waitRun(t, r, dir, retry.Run.Id)
}

type admittedRun struct {
	result RunResult
	err    error
}
type admittedRelease struct {
	result ReleaseStartResult
	err    error
}

func TestAdmissionSameKindBeforeRecordExists(t *testing.T) {
	r, dir := makeReleaseFixture(t, admissionPipeline)
	trustAdmission(t, r, dir)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	if result, err := r.Start(RunRequest{Dir: alias, Kind: RunKindStep, Id: "two"}); err != nil || result.Untrusted == nil {
		t.Fatalf("alias inherited trust: %+v, %v", result, err)
	}
	trustAdmission(t, r, alias)
	entered, proceed := holdAdmission(t, r, "symbolic-ref")
	first := make(chan admittedRun, 1)
	go func() {
		res, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "one"})
		first <- admittedRun{res, err}
	}()
	admissionResult(t, entered)
	second := make(chan admittedRun, 1)
	go func() {
		res, err := r.Start(RunRequest{Dir: alias, Kind: RunKindStep, Id: "two"})
		second <- admittedRun{res, err}
	}()
	loser := admissionResult(t, second)
	proceed()
	winner := admissionResult(t, first)
	if loser.err == nil || !strings.Contains(loser.err.Error(), "already running") || loser.result.Run != nil {
		t.Fatalf("contender was not refused: %+v", loser)
	}
	if winner.err != nil || winner.result.Run == nil {
		t.Fatalf("first request failed: %+v", winner)
	}
	waitRun(t, r, dir, winner.result.Run.Id)
	data, err := os.ReadFile(filepath.Join(dir, "launches"))
	if err != nil || string(data) != "child\n" {
		t.Fatalf("expected exactly one child: %q, %v", data, err)
	}
}

func TestAdmissionDoesNotSerializeOtherKindsOrProjects(t *testing.T) {
	r, dir := makeReleaseFixture(t, admissionPipeline)
	_, other := makeReleaseFixture(t, admissionPipeline)
	trustAdmission(t, r, dir)
	trustAdmission(t, r, other)
	entered, proceed := holdAdmission(t, r, "symbolic-ref")
	first := make(chan admittedRun, 1)
	go func() {
		res, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "one"})
		first <- admittedRun{res, err}
	}()
	admissionResult(t, entered)
	for _, request := range []RunRequest{{Dir: dir, Kind: RunKindBuild, Id: "build"}, {Dir: other, Kind: RunKindStep, Id: "two"}} {
		result := make(chan admittedRun, 1)
		go func(req RunRequest) { res, err := r.Start(req); result <- admittedRun{res, err} }(request)
		accepted := admissionResult(t, result)
		if accepted.err != nil || accepted.result.Run == nil {
			proceed()
			admissionResult(t, first)
			t.Fatalf("unrelated request blocked: %+v", accepted)
		}
		waitRun(t, r, request.Dir, accepted.result.Run.Id)
	}
	proceed()
	accepted := admissionResult(t, first)
	if accepted.err != nil || accepted.result.Run == nil {
		t.Fatalf("first request failed: %+v", accepted)
	}
	waitRun(t, r, dir, accepted.result.Run.Id)
}

func TestAdmissionReleaseStartEndAndStepShareBoundary(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	trustAdmission(t, r, dir)
	entered, proceed := holdAdmission(t, r, "refs/tags/v1.2.0-3")
	first := make(chan admittedRelease, 1)
	go func() {
		res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.2.0-3"})
		first <- admittedRelease{res, err}
	}()
	admissionResult(t, entered)
	for _, attempt := range []func() error{
		func() error {
			_, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.3.0-1"})
			return err
		},
		func() error { return r.EndRelease(dir) },
		func() error { return r.StopFollowing(dir, "v1.2.0-3") },
		func() error {
			_, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.2.0-3", Step: "cut"})
			return err
		},
	} {
		result := make(chan error, 1)
		go func(call func() error) { result <- call() }(attempt)
		if err := admissionResult(t, result); err == nil || !strings.Contains(err.Error(), "still running") {
			proceed()
			admissionResult(t, first)
			t.Fatalf("concurrent release operation accepted: %v", err)
		}
	}
	proceed()
	winner := admissionResult(t, first)
	if winner.err != nil || winner.result.Run == nil || winner.result.Session == nil {
		t.Fatalf("release failed: %+v", winner)
	}
	waitRun(t, r, dir, winner.result.Run.Id)
	session, err := r.ReleaseSessionOf(dir)
	if err != nil || session == nil || session.Tag != "v1.2.0-3" || len(r.List(dir)) != 1 {
		t.Fatalf("incoherent session/preparation: %+v, %v", session, err)
	}
}

func TestAdmissionFailuresReleaseReservation(t *testing.T) {
	for _, failure := range []string{"validation", "record", "startup"} {
		t.Run(failure, func(t *testing.T) {
			r, dir := makeReleaseFixture(t, admissionPipeline)
			trustAdmission(t, r, dir)
			request := RunRequest{Dir: dir, Kind: RunKindStep, Id: "one"}
			switch failure {
			case "validation":
				request.Version = "invalid;version"
			case "record":
				if err := os.WriteFile(r.baseDir, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "startup":
				r.agentEnv = func(string) []string {
					if err := os.Rename(dir, dir+"-moved"); err != nil {
						t.Error(err)
					}
					return nil
				}
			}
			if result, err := r.Start(request); err == nil || result.Run != nil {
				t.Fatalf("failure unexpectedly accepted: %+v, %v", result, err)
			}
			switch failure {
			case "validation":
				request.Version = ""
			case "record":
				if err := os.Remove(r.baseDir); err != nil {
					t.Fatal(err)
				}
			case "startup":
				r.agentEnv = nil
				if err := os.Rename(dir+"-moved", dir); err != nil {
					t.Fatal(err)
				}
			}
			result, err := r.Start(request)
			if err != nil || result.Run == nil {
				t.Fatalf("failed request leaked admission: %+v, %v", result, err)
			}
			waitRun(t, r, dir, result.Run.Id)
		})
	}
}

func TestAdmissionReleaseRollbackAllowsRetry(t *testing.T) {
	for _, failure := range []string{"session", "startup"} {
		t.Run(failure, func(t *testing.T) { testAdmissionReleaseRollback(t, failure) })
	}
}

func testAdmissionReleaseRollback(t *testing.T, failure string) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	trustAdmission(t, r, dir)
	if failure == "session" {
		if err := os.WriteFile(r.baseDir, nil, 0600); err != nil {
			t.Fatal(err)
		}
	} else {
		r.agentEnv = func(string) []string {
			if err := os.Rename(dir, dir+"-moved"); err != nil {
				t.Error(err)
			}
			return nil
		}
	}
	request := ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.2.0-3"}
	result, err := r.StartRelease(request)
	r.agentEnv = nil
	if failure == "session" {
		if err := os.Remove(r.baseDir); err != nil {
			t.Fatal(err)
		}
	} else {
		if restore := os.Rename(dir+"-moved", dir); restore != nil {
			t.Fatal(restore)
		}
	}
	if err == nil || result.Session != nil {
		t.Fatalf("startup failure accepted: %+v, %v", result, err)
	}
	if session, err := r.ReleaseSessionOf(dir); err != nil || session != nil {
		t.Fatalf("failed session survived: %+v, %v", session, err)
	}
	result, err = r.StartRelease(request)
	if err != nil || result.Run == nil {
		t.Fatalf("retry refused: %+v, %v", result, err)
	}
	waitRun(t, r, dir, result.Run.Id)
}

func TestAdmissionConcurrentReleaseSteps(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	trustAdmission(t, r, dir)
	if err := r.writeReleaseSession(dir, ReleaseSession{Tag: "v1.2.0-3", Channel: ReleaseChannelRc, Version: "1.2.0-3"}); err != nil {
		t.Fatal(err)
	}
	entered, proceed := holdAdmission(t, r, "symbolic-ref")
	first := make(chan admittedRun, 1)
	request := ReleaseStepRequest{Dir: dir, Tag: "v1.2.0-3", Step: "cut"}
	go func() { result, err := r.RunReleaseStep(request); first <- admittedRun{result, err} }()
	admissionResult(t, entered)
	second := make(chan admittedRun, 1)
	go func() { result, err := r.RunReleaseStep(request); second <- admittedRun{result, err} }()
	loser := admissionResult(t, second)
	end := r.EndRelease(dir)
	proceed()
	winner := admissionResult(t, first)
	if loser.err == nil || loser.result.Run != nil || end == nil {
		t.Fatalf("step/end bypassed initialization: %+v, %v", loser, end)
	}
	if winner.err != nil || winner.result.Run == nil {
		t.Fatalf("first step failed: %+v", winner)
	}
	waitRun(t, r, dir, winner.result.Run.Id)
	if runs := r.List(dir); len(runs) != 1 {
		t.Fatalf("expected one step process: %+v", runs)
	}
}

func writeLegacyAdmissionRecord(t *testing.T, r *Runs, dir, id string, pid int) {
	t.Helper()
	storage := filepath.Join(r.baseDir, projectKey(dir), id)
	if err := os.MkdirAll(storage, 0700); err != nil {
		t.Fatal(err)
	}
	record := RunRecord{Dir: dir, Id: id, Kind: RunKindStep, Title: id, State: RunStateRunning, Pid: pid, StartedAt: time.Now().UnixMilli()}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(storage, RunFileName), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, LogFileName), nil, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAdmissionLegacyAliasHistoryAfterRestart(t *testing.T) {
	r, dir := makeReleaseFixture(t, admissionPipeline)
	trustAdmission(t, r, dir)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sh", "-c", "read token")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { input.Close(); cmd.Process.Kill() })
	writeLegacyAdmissionRecord(t, r, dir, "canonical-history", 0)
	writeLegacyAdmissionRecord(t, r, alias, "legacy-alias", cmd.Process.Pid)
	restarted := MakeRuns(r.baseDir, r.trust, nil)
	restarted.git = plainRunner
	t.Cleanup(func() { waitRunsIdle(t, restarted) })
	if runs := restarted.List(dir); len(runs) != 2 {
		t.Fatalf("alias history hidden: %+v", runs)
	}
	if result, err := restarted.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "one"}); err == nil || result.Run != nil {
		t.Fatalf("legacy active alias bypassed exclusion: %+v, %v", result, err)
	}
	if err := restarted.Cancel(dir, "legacy-alias"); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	if rec := waitRun(t, restarted, dir, "legacy-alias"); rec.State != RunStateCancelled {
		t.Fatalf("alias cancellation lost: %+v", rec)
	}
	if _, err := os.Stat(filepath.Join(r.baseDir, projectKey(alias), "legacy-alias", RunFileName)); err != nil {
		t.Fatalf("legacy record was moved: %v", err)
	}
	last := MakeRuns(r.baseDir, r.trust, nil)
	if runs := last.List(dir); len(runs) != 2 {
		t.Fatalf("history disappeared after restart: %+v", runs)
	}
}

func TestAdmissionRetargetedAliasDoesNotExposePreviousProject(t *testing.T) {
	r, dir := makeReleaseFixture(t, admissionPipeline)
	_, other := makeReleaseFixture(t, admissionPipeline)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	trustAdmission(t, r, alias)
	result, err := r.Start(RunRequest{Dir: alias, Kind: RunKindStep, Id: "one"})
	if err != nil || result.Run == nil {
		t.Fatalf("first run failed: %+v, %v", result, err)
	}
	waitRun(t, r, dir, result.Run.Id)
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, alias); err != nil {
		t.Fatal(err)
	}
	for _, runs := range []*Runs{r, MakeRuns(r.baseDir, r.trust, nil)} {
		if records := runs.List(alias); len(records) != 0 {
			t.Fatalf("retargeted alias exposed old runs: %+v", records)
		}
		if records := runs.List(dir); len(records) != 1 || records[0].Id != result.Run.Id {
			t.Fatalf("original project lost its history: %+v", records)
		}
		if err := runs.Cancel(alias, result.Run.Id); err == nil {
			t.Fatal("new project could address previous project's run")
		}
	}
}

func TestAdmissionPinsProjectBeforeExternalLookup(t *testing.T) {
	for _, kind := range []string{RunKindStep, RunKindRelease} {
		t.Run(kind, func(t *testing.T) {
			pipeline, lookup := admissionPipeline, "symbolic-ref"
			if kind == RunKindRelease {
				pipeline, lookup = releasePipeline, "refs/tags/v1.2.0-3"
			}
			r, dir := makeReleaseFixture(t, pipeline)
			_, other := makeReleaseFixture(t, pipeline)
			alias := filepath.Join(t.TempDir(), "project")
			if err := os.Symlink(dir, alias); err != nil {
				t.Fatal(err)
			}
			trustAdmission(t, r, alias)
			trustAdmission(t, r, other)
			entered, proceed := holdAdmission(t, r, lookup)
			start := func(dir string) admittedRun {
				if kind == RunKindRelease {
					result, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.2.0-3"})
					return admittedRun{RunResult{Run: result.Run}, err}
				}
				result, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "one"})
				return admittedRun{result, err}
			}
			first := make(chan admittedRun, 1)
			go func() { first <- start(alias) }()
			admissionResult(t, entered)
			if err := os.Remove(alias); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(other, alias); err != nil {
				t.Fatal(err)
			}
			second := start(other)
			proceed()
			original := admissionResult(t, first)
			if original.err != nil || original.result.Run == nil || second.err != nil || second.result.Run == nil {
				t.Fatalf("independent pinned projects failed: %+v, %+v", original, second)
			}
			waitRun(t, r, dir, original.result.Run.Id)
			waitRun(t, r, other, second.result.Run.Id)
			if original.result.Run.Dir != alias {
				t.Fatalf("requested path changed: %q", original.result.Run.Dir)
			}
			for _, project := range []string{dir, other} {
				if records := r.List(project); len(records) != 1 {
					t.Fatalf("lookup retarget moved work between projects: %s: %+v", project, records)
				}
			}
			if kind == RunKindStep {
				for _, project := range []string{dir, other} {
					data, err := os.ReadFile(filepath.Join(project, "launches"))
					if err != nil || string(data) != "child\n" {
						t.Fatalf("command used retargeted path: %s: %q, %v", project, data, err)
					}
				}
			} else {
				for _, project := range []string{dir, other} {
					if session, err := r.ReleaseSessionOf(project); err != nil || session == nil || session.Tag != "v1.2.0-3" {
						t.Fatalf("session moved during lookup: %s: %+v, %v", project, session, err)
					}
				}
			}
		})
	}
}

func TestAdmissionReleaseWithoutPreparationSurvivesAliasRestart(t *testing.T) {
	r, dir := makeReleaseFixture(t, `{"schema":1,"name":"fixture","release":{"rc":[{"id":"cut","phase":"cut","run":"echo cut"}]}}`)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	trustAdmission(t, r, alias)
	result, err := r.StartRelease(ReleaseStartRequest{Dir: alias, Channel: ReleaseChannelRc, Tag: "v1.2.0-3"})
	if err != nil || result.Session == nil || result.Run != nil {
		t.Fatalf("session-only release failed: %+v, %v", result, err)
	}
	restarted := MakeRuns(r.baseDir, r.trust, nil)
	restarted.git = plainRunner
	session, err := restarted.ReleaseSessionOf(dir)
	if err != nil || session == nil || session.Tag != result.Session.Tag {
		t.Fatalf("session-only identity lost: %+v, %v", session, err)
	}
	trustAdmission(t, restarted, dir)
	if second, err := restarted.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.3.0-1"}); err == nil || second.Session != nil {
		t.Fatalf("session overwritten through alias: %+v, %v", second, err)
	}
	if err := restarted.EndRelease(dir); err != nil {
		t.Fatal(err)
	}
	if session, err := restarted.ReleaseSessionOf(alias); err != nil || session != nil {
		t.Fatalf("ended session survived: %+v, %v", session, err)
	}
}

func TestAdmissionKeepsIgnoredTagsAcrossHistoricalAliases(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	for _, project := range []string{dir, alias} {
		writeLegacyAdmissionRecord(t, r, project, "history", 0)
	}
	for project, data := range map[string]string{dir: `["v1.2.0-1"]`, alias: `["v1.1.0-1","v1.2.0-1"]`} {
		file := filepath.Join(r.baseDir, projectKey(project), ReleaseIgnoredFileName)
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(file, time.Unix(1, 0), time.Unix(1, 0)); err != nil {
			t.Fatal(err)
		}
	}
	restarted := MakeRuns(r.baseDir, r.trust, nil)
	if tags := restarted.ignoredReleases(dir); strings.Join(tags, ",") != "v1.1.0-1,v1.2.0-1" {
		t.Fatalf("historical ignored tags hidden: %+v", tags)
	}
	if err := restarted.IgnoreRelease(dir, "v1.3.0-1"); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(restarted.projectDir(dir), ReleaseIgnoredFileName), time.Unix(2, 0), time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	last := MakeRuns(r.baseDir, r.trust, nil)
	if tags := last.ignoredReleases(alias); strings.Join(tags, ",") != "v1.1.0-1,v1.2.0-1,v1.3.0-1" {
		t.Fatalf("ignored choices lost after restart: %+v", tags)
	}
}

func TestAdmissionFindsOriginalLegacySessionAfterCanonicalCache(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	storage := filepath.Join(r.baseDir, projectKey(alias))
	if err := os.MkdirAll(storage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, ReleaseSessionFileName), []byte(`{"tag":"v1.2.0-3","channel":"rc","version":"1.2.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	canonical := canonicalRunDir(dir)
	want := ReleaseSession{Tag: "v1.2.0-3", Channel: ReleaseChannelRc, Version: "1.2.0"}
	if session, err := r.ReleaseSessionOf(canonical); err != nil || session != nil {
		t.Fatalf("unknown alias session should remain undiscoverable: %+v, %v", session, err)
	}
	for _, requested := range []string{alias, canonical} {
		if session, err := r.ReleaseSessionOf(requested); err != nil || session == nil || *session != want {
			t.Fatalf("original alias did not enrich cached identity: %s: %+v, %v", requested, session, err)
		}
	}
	data, err := os.ReadFile(filepath.Join(storage, runProjectFile))
	var identity string
	if err != nil || json.Unmarshal(data, &identity) != nil || identity != canonical {
		t.Fatalf("identity was not backfilled beside the actual session: %q, %v", data, err)
	}
	restarted := MakeRuns(r.baseDir, r.trust, nil)
	if session, err := restarted.ReleaseSessionOf(canonical); err != nil || session == nil || *session != want {
		t.Fatalf("backfilled session identity lost after restart: %+v, %v", session, err)
	}
	_, other := makeReleaseFixture(t, releasePipeline)
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, alias); err != nil {
		t.Fatal(err)
	}
	retargeted := MakeRuns(r.baseDir, r.trust, nil)
	if session, err := retargeted.ReleaseSessionOf(alias); err != nil || session != nil {
		t.Fatalf("backfilled old session attached to retargeted alias: %+v, %v", session, err)
	}
	if session, err := retargeted.ReleaseSessionOf(canonical); err != nil || session == nil || *session != want {
		t.Fatalf("retargeting lost original project's session: %+v, %v", session, err)
	}
	if err := restarted.EndRelease(canonical); err != nil {
		t.Fatal(err)
	}
	if session, err := restarted.ReleaseSessionOf(alias); err != nil || session != nil {
		t.Fatalf("ended legacy session survived: %+v, %v", session, err)
	}
}

func TestAdmissionBackfillsSecondaryRecordBeforeRetarget(t *testing.T) {
	r, dir := makeReleaseFixture(t, admissionPipeline)
	_, other := makeReleaseFixture(t, admissionPipeline)
	alias := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	writeLegacyAdmissionRecord(t, r, dir, "canonical", 0)
	writeLegacyAdmissionRecord(t, r, alias, "secondary", 0)
	if records := r.List(dir); len(records) != 2 {
		t.Fatalf("legacy records missing before retarget: %+v", records)
	}
	var identity string
	data, err := os.ReadFile(filepath.Join(r.baseDir, projectKey(alias), runProjectFile))
	if err != nil || json.Unmarshal(data, &identity) != nil || identity != canonicalRunDir(dir) {
		t.Fatalf("secondary record's actual folder was not identified: %q, %v", data, err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, alias); err != nil {
		t.Fatal(err)
	}
	restarted := MakeRuns(r.baseDir, r.trust, nil)
	if records := restarted.List(alias); len(records) != 0 {
		t.Fatalf("retargeted alias inherited another project's history: %+v", records)
	}
	records := restarted.List(dir)
	seen := map[string]bool{}
	for _, record := range records {
		seen[record.Id] = record.State == RunStateLost
	}
	if len(records) != 2 || !seen["canonical"] || !seen["secondary"] {
		t.Fatalf("backfilled history lost after restart: %+v", records)
	}
}
