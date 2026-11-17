// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A build's local CI has no total time limit, only a stall guard, and a build stopped by a limit or by the developer
// says why (#2273). The clock the build reads is the test's: no test waits minutes.

func makeVerifyFixture(t *testing.T, job string) (*Runs, string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	pipeline := `{"schema":1,"name":"P","ci":{"jobs":[{"name":"check","run":` + jsonString(job) + `}]},
		"builds":[{"id":"gold","kind":"gold","verify":"ci","run":"echo '▶ phase: build'"}]}`
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(pipeline), 0644)
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	data := t.TempDir()
	trust := MakeTrustStore(filepath.Join(data, TrustFileName))
	r := makeTestRuns(filepath.Join(data, "runs"), trust, nil)
	t.Cleanup(func() { waitRunsIdle(t, r) })
	r.git = withoutGh
	r.UseCi(MakeCi(filepath.Join(data, "ci"), trust, withoutGh, nil))
	return r, dir, data
}

// silentJob says it started, then waits without a word until it is stopped. The shell becomes the sleep (exec): a
// shell stopped while it forks would leave its child behind.
func silentJob(mark string) string {
	return "touch " + mark + " && exec sleep 600"
}

func jsonString(s string) string {
	return fmt.Sprintf("%q", s)
}

func buildLogText(t *testing.T, data string, runId string) string {
	t.Helper()
	logs, _ := filepath.Glob(filepath.Join(data, "runs", "*", runId, LogFileName))
	if len(logs) != 1 {
		t.Fatalf("the build's log: %v", logs)
	}
	text, _ := os.ReadFile(logs[0])
	return string(text)
}

func ciJobLog(data string) string {
	logs, _ := filepath.Glob(filepath.Join(data, "ci", "*", "runs", "*", "check.log"))
	if len(logs) != 1 {
		return ""
	}
	text, _ := os.ReadFile(logs[0])
	return string(text)
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(testPoll)
	}
	t.Fatalf("%s did not appear", filepath.Base(path))
}

// Acceptance 1: a CI that keeps writing goes on for longer than the old 15 minutes and the build follows it.
func TestBuildVerifyGoesOnWhileTheCiProgresses(t *testing.T) {
	t.Parallel()
	ack := filepath.Join(t.TempDir(), "ack")
	steps := 6
	job := fmt.Sprintf(`for i in $(seq 1 %d); do echo "step $i"; until grep -qx "$i" %s 2>/dev/null; do sleep 0.01; done; done`, steps, ack)
	r, dir, data := makeVerifyFixture(t, job)
	// Each line the job writes moves the clock 4 minutes on, and the job writes the next one only once the clock has.
	var lock sync.Mutex
	base, offset, acked := time.Now(), time.Duration(0), 0
	r.now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		if written := strings.Count(ciJobLog(data), "\nstep "); written > acked {
			offset += time.Duration(written-acked) * 4 * time.Minute
			acked = written
			os.WriteFile(ack, []byte(fmt.Sprintf("%d\n", acked)), 0600)
		}
		return base.Add(offset)
	}
	built := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	if built.State != RunStateSuccess || strings.Join(built.Phases, ",") != "verify,build" || built.Stopped != "" {
		t.Fatalf("a CI that makes progress lets the build go on: %+v\n%s", built, buildLogText(t, data, built.Id))
	}
	lock.Lock()
	defer lock.Unlock()
	if offset <= 15*time.Minute {
		t.Fatalf("the CI ran %v on the build's clock, not past the old 15 minutes", offset)
	}
}

// Acceptance 2: a CI silent past the stall bound stops the build; the log, the record and the notification name the job.
func TestBuildStopsWhenTheCiMakesNoProgress(t *testing.T) {
	t.Parallel()
	mark := filepath.Join(t.TempDir(), "started")
	r, dir, data := makeVerifyFixture(t, silentJob(mark))
	// Once the job runs, every reading of the clock is 11 minutes later: past the stall bound with no progress.
	var lock sync.Mutex
	base, offset := time.Now(), time.Duration(0)
	r.now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		if _, err := os.Stat(mark); err == nil {
			offset += 11 * time.Minute
		}
		return base.Add(offset)
	}
	told := make(chan molten.NotificationInput, 1)
	r.UseNotifier(func(rec RunRecord, input molten.NotificationInput) { told <- input })
	failed := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	want := "Stopped: the local CI made no progress for 10 minutes (check). Relaunch the build: the jobs already green are reused."
	if failed.State != RunStateFailure || failed.Stopped != want || failed.StoppedText == nil ||
		failed.StoppedText.Code != "mission.build.stalled" || failed.StoppedText.Vars["jobs"] != "check" {
		t.Fatalf("a stalled CI stops the build and says which job: %+v", failed)
	}
	if log := buildLogText(t, data, failed.Id); !strings.Contains(log, want) || !strings.Contains(log, "check          cancelled") {
		t.Fatalf("the log says why and the CI job was cancelled:\n%s", log)
	}
	select {
	case input := <-told:
		if input.Message != want || input.MessageText == nil || input.MessageText.Code != "mission.build.stalled" {
			t.Fatalf("the notification carries the reason: %+v", input)
		}
	case <-time.After(time.Minute):
		t.Fatal("the stopped build was not told")
	}
}

// Acceptance 3: a prepare command that hangs is stopped by its own bound.
func TestBuildPrepareThatHangsIsBounded(t *testing.T) {
	t.Parallel()
	r, dir := makeRunsFixture(t, `{"id":"gold","prepare":{"run":"exec sleep 600"},"run":"true"}`)
	r.stepTimeout = 100 * time.Millisecond
	// The git steps keep no bound here: only the prepare command is meant to hit the short one.
	r.git = func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		return withoutGh(context.Background(), dir, name, args...)
	}
	failed := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	if failed.State != RunStateFailure || failed.StoppedText == nil || failed.StoppedText.Code != "mission.build.prepareTimeout" ||
		!strings.HasPrefix(failed.Stopped, "Stopped: the build's prepare command took longer than") {
		t.Fatalf("a hanging prepare stops the build and says so: %+v", failed)
	}
}

// Acceptance 3: a fetch that hangs is cut by its bound and the build goes on with the trunk already fetched.
func TestBuildFetchThatHangsIsBounded(t *testing.T) {
	t.Parallel()
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	r.stepTimeout = 100 * time.Millisecond
	r.git = func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		if name == "git" && len(args) > 0 && args[0] == "fetch" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return withoutGh(context.Background(), dir, name, args...)
	}
	built := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	chunk, err := r.ReadLog(dir, built.Id, 0)
	if err != nil || built.State != RunStateSuccess || !strings.Contains(chunk.Text, "git fetch took longer than") ||
		!strings.Contains(chunk.Text, "building the last fetched develop") {
		t.Fatalf("a hanging fetch is cut and the build goes on: %+v %v\n%s", built, err, chunk.Text)
	}
}

// Acceptance 4: a cancel by the developer while the CI runs is worded as such.
func TestBuildCancelledWhileVerifyingSaysByYou(t *testing.T) {
	t.Parallel()
	mark := filepath.Join(t.TempDir(), "started")
	r, dir, data := makeVerifyFixture(t, silentJob(mark))
	started :=trustAndStart(t, r, dir, "gold")
	waitFile(t, mark)
	if err := r.Cancel(dir, started.Id); err != nil {
		t.Fatal(err)
	}
	cancelled := waitRun(t, r, dir, started.Id)
	if cancelled.State != RunStateCancelled || cancelled.Stopped != "Cancelled by you." ||
		cancelled.StoppedText == nil || cancelled.StoppedText.Code != "mission.build.cancelled" {
		t.Fatalf("a cancel says it was the developer's: %+v", cancelled)
	}
	if log := buildLogText(t, data, started.Id); !strings.Contains(log, "Cancelled by you.") {
		t.Fatalf("the log says it was cancelled:\n%s", log)
	}
}

func TestVerifyWatchMeasuresFromTheLastProgress(t *testing.T) {
	t.Parallel()
	start := time.Unix(1_000_000, 0)
	w := verifyWatch{last: start}
	if got := w.observe(start, "a"); got != 0 {
		t.Fatalf("a change is progress: %v", got)
	}
	if got := w.observe(start.Add(9*time.Minute), "a"); got != 9*time.Minute {
		t.Fatalf("no change measures from the last one: %v", got)
	}
	if got := w.observe(start.Add(30*time.Minute), "b"); got != 0 {
		t.Fatalf("a late change still resets: %v", got)
	}
	if got := w.observe(start.Add(41*time.Minute), "b"); got != 11*time.Minute {
		t.Fatalf("measured from the change: %v", got)
	}
}
