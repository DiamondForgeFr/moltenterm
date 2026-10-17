// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func completionPoll(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("completion condition was not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func completionWrite(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func heldCommand(gate string, code int) string {
	return fmt.Sprintf("printf 'exit=0\\nexit=1\\nexit=0\\n'; printf 'ex'; printf 'it=1\\n'; touch '%s.ready'; while ! test -f '%s'; do sleep 0.02; done; exit %d", gate, gate, code)
}

func TestRunOutputCannotCompleteLiveCommand(t *testing.T) {
	for _, kind := range []string{RunKindStep, RunKindBuild, RunKindRelease} {
		t.Run(kind, func(t *testing.T) {
			r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
			gate := filepath.Join(t.TempDir(), "release")
			var notices int
			var noticeLock sync.Mutex
			r.UseNotifier(func(RunRecord, molten.NotificationInput) { noticeLock.Lock(); defer noticeLock.Unlock(); notices++ })
			var rec RunRecord
			var err error
			if kind == RunKindBuild {
				rec, err = r.startBuild(dir, molten.PipelineBuild{Id: "gold", Prepare: &molten.PipelineCommand{Run: "printf 'exit=1\\n'"}, PipelineCommand: molten.PipelineCommand{Run: heldCommand(gate, 7)}}, "")
			} else {
				rec, err = r.launch(dir, TrustedCommand{Kind: kind, Id: "fixture", Run: heldCommand(gate, 7)}, "", "", "v1.0.0")
			}
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { completionWrite(t, gate, "release"); waitRun(t, r, dir, rec.Id); waitRunsIdle(t, r) })
			completionPoll(t, func() bool { _, err := os.Stat(gate + ".ready"); return err == nil })
			completionPoll(t, func() bool { current, err := r.readRecord(dir, rec.Id); return err == nil && !current.Preparing })
			current := r.List(dir)[0]
			if current.State != RunStateRunning || current.Exit != nil || !processAlive(current.Pid) {
				t.Fatalf("ordinary output completed a live command: %+v", current)
			}
			if r.runningOf(dir, kind) == nil {
				t.Fatal("admission lost the running command")
			}
			noticeLock.Lock()
			count := notices
			noticeLock.Unlock()
			if count != 0 {
				t.Fatal("output emitted a completion notification")
			}
			if kind == RunKindRelease {
				facts, _, _ := r.stepFacts(dir, "v1.0.0", 0)
				fact := facts["fixture"]
				if !fact.Running || fact.Exit != nil || !strings.Contains(strings.Join(fact.Tail, "\n"), "exit=0") {
					t.Fatalf("release facts: %+v", fact)
				}
			}
			if err := r.Cancel(dir, rec.Id); err != nil {
				t.Fatal(err)
			}
			ended := waitRun(t, r, dir, rec.Id)
			if ended.State != RunStateCancelled || ended.Exit == nil || *ended.Exit == 0 {
				t.Fatalf("cancel result: %+v", ended)
			}
		})
	}
}

func TestRunCompletionIgnoresMissingAndMalformedControl(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	for i, control := range []string{"", "exit=0\n", "1", "1 256\n", "1 -1\n", "1 0 extra\n"} {
		rec := RunRecord{Id: fmt.Sprintf("invalid-%d", i), Dir: dir, State: RunStateRunning, Pid: os.Getpid()}
		if err := os.MkdirAll(filepath.Dir(r.completionFile(rec)), 0700); err != nil {
			t.Fatal(err)
		}
		completionWrite(t, r.completionFile(rec), control)
		completionWrite(t, r.logFile(dir, rec.Id), "exit=0\n")
		r.update(&rec)
		if rec.State != RunStateRunning || rec.Exit != nil {
			t.Fatalf("invalid control completed run: %+v", rec)
		}
		rec.Pid = 0
		r.update(&rec)
		if rec.State != RunStateLost || rec.Exit != nil {
			t.Fatalf("unknown exit must remain lost: %+v", rec)
		}
	}
	for _, code := range []int{0, 9} {
		rec := RunRecord{Id: fmt.Sprintf("valid-%d", code), Dir: dir, State: RunStateRunning}
		if err := os.MkdirAll(filepath.Dir(r.completionFile(rec)), 0700); err != nil {
			t.Fatal(err)
		}
		completionWrite(t, r.completionFile(rec), fmt.Sprintf("1 %d\n", code))
		r.update(&rec)
		if rec.Exit == nil || *rec.Exit != code || rec.State == RunStateLost {
			t.Fatalf("missing output hid completion: %+v", rec)
		}
	}
}

func TestRunLogChunksNeverSupplyCompletion(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	rec := RunRecord{Id: "chunks", Dir: dir, State: RunStateRunning, Pid: os.Getpid()}
	if err := os.MkdirAll(filepath.Dir(r.logFile(dir, rec.Id)), 0700); err != nil {
		t.Fatal(err)
	}
	output := ""
	for _, chunk := range []string{"exit=0\n", "exit=1\n", "exit=0\nexit=0\n", "ex", "it=", "1", "\n"} {
		output += chunk
		completionWrite(t, r.logFile(dir, rec.Id), output)
		r.update(&rec)
		if rec.State != RunStateRunning || rec.Exit != nil || rec.FinishedAt != 0 {
			t.Fatalf("chunk %q supplied completion: %+v", chunk, rec)
		}
	}
}

func TestRunCancellationBeforeSupervisorStartsChild(t *testing.T) {
	testRunCancellationAtStartup(t, false, false)
}

func TestRunCancellationBeforeChildExec(t *testing.T) {
	testRunCancellationAtStartup(t, true, false)
}

// dash runs no handler for a signal that reaches its subshell before the inherited trap is reset: the child loses
// both the cancel and the supervisor's forwarded signal, then started the command anyway (#894). The child here
// ignores signals until its gate opens to hold that window open.
func TestRunCancellationLostByTheChild(t *testing.T) {
	testRunCancellationAtStartup(t, true, true)
}

func testRunCancellationAtStartup(t *testing.T, beforeExec bool, childLosesSignal bool) {
	t.Helper()
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	base := t.TempDir()
	rec := RunRecord{Id: "cancel-before-child", Dir: dir, State: RunStateRunning, Command: "sleep 300"}
	if err := os.MkdirAll(filepath.Dir(r.completionFile(rec)), 0700); err != nil {
		t.Fatal(err)
	}
	cmd := r.supervisedCommand(rec)
	// Hold the real supervisor before fork, or its child before resetting inherited traps and exec.
	// Observe the supervisor's trap before releasing the gate: the signal cannot miss the chosen window.
	cmd.Args[2] = strings.Replace(cmd.Args[2], "    fi\n}\n", "    fi\n    : > \"$MOLTEN_CANCEL_ACK\"\n}\n", 1)
	gate := `: > "$5"
while [ ! -f "$4" ]; do sleep 0.02; done
`
	if childLosesSignal {
		gate = "trap '' TERM INT\n" + gate
	}
	if beforeExec {
		cmd.Args[2] = strings.Replace(cmd.Args[2], "    trap - TERM INT\n", gate+"    trap - TERM INT\n", 1)
	} else {
		cmd.Args[2] = strings.Replace(cmd.Args[2], "trap cancel_run TERM INT\n", "trap cancel_run TERM INT\n"+gate, 1)
	}
	ack, release, ready := filepath.Join(base, "signal"), filepath.Join(base, "release"), filepath.Join(base, "ready")
	cmd.Args = append(cmd.Args, ack, release, ready)
	cmd.Env = append(os.Environ(), "MOLTEN_CANCEL_ACK="+ack)
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	rec.Pid = cmd.Process.Pid
	finished := make(chan struct{})
	go func() { _ = cmd.Wait(); close(finished) }()
	t.Cleanup(func() {
		completionWrite(t, release, "release")
		_ = killRunGroup(rec.Pid)
		<-finished
		waitRunsIdle(t, r)
	})
	if err := r.writeRecord(rec); err != nil {
		t.Fatal(err)
	}
	completionPoll(t, func() bool { _, err := os.Stat(ready); return err == nil })
	if err := r.Cancel(dir, rec.Id); err != nil {
		t.Fatal(err)
	}
	completionPoll(t, func() bool { _, err := os.Stat(ack); return err == nil })
	completionWrite(t, release, "release")
	ended := waitRun(t, r, dir, rec.Id)
	if ended.State != RunStateCancelled || ended.Exit == nil || *ended.Exit == 0 {
		t.Fatalf("startup cancellation was lost (beforeExec=%t, childLosesSignal=%t): %+v", beforeExec, childLosesSignal, ended)
	}
}

func TestBuildPreparationUsesItsActualResult(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","prepare":{"run":"printf 'exit=0\\n'; exit 11"},"run":"echo should-not-run"}`)
	rec := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	if rec.State != RunStateFailure || rec.Exit == nil || *rec.Exit != 11 {
		t.Fatalf("preparation trusted its output: %+v", rec)
	}
	log, err := r.ReadLog(dir, rec.Id, 0)
	if err != nil || !strings.Contains(log.Text, "exit=0") || strings.Contains(log.Text, "should-not-run") {
		t.Fatalf("preparation output/handoff: %+v %v", log, err)
	}
}

func TestRunTerminalHistoryRemainsUnchanged(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	code := 3
	rec := RunRecord{Id: "history", Dir: dir, State: RunStateFailure, Exit: &code, FinishedAt: 42, Closed: true}
	if err := os.MkdirAll(filepath.Dir(r.completionFile(rec)), 0700); err != nil {
		t.Fatal(err)
	}
	completionWrite(t, r.completionFile(rec), "1 0\n")
	completionWrite(t, r.logFile(dir, rec.Id), "exit=0\n")
	if err := r.writeRecord(rec); err != nil {
		t.Fatal(err)
	}
	got := r.List(dir)[0]
	if got.State != rec.State || got.Exit == nil || *got.Exit != 3 || got.FinishedAt != 42 || !got.Closed {
		t.Fatalf("terminal history was reinterpreted: %+v", got)
	}
}

// A real helper exits without waiting for its detached command. The parent then acts as the restarted app.
func TestRunCompletionRestartHelper(t *testing.T) {
	base := os.Getenv("MOLTEN_COMPLETION_HELPER")
	if base == "" {
		return
	}
	r := MakeRuns(filepath.Join(base, "runs"), nil, nil)
	r.git = plainRunner
	_, err := r.launch(base, TrustedCommand{Kind: RunKindStep, Id: "fixture", Run: heldCommand(filepath.Join(base, "release"), 7)}, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
}

func TestRunCompletionSurvivesApplicationRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	for _, finishBeforeRestart := range []bool{false, true} {
		t.Run(fmt.Sprint(finishBeforeRestart), func(t *testing.T) {
			base := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestRunCompletionRestartHelper$")
			cmd.Env = append(os.Environ(), "MOLTEN_COMPLETION_HELPER="+base)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("helper: %v %s", err, out)
			}
			r := MakeRuns(filepath.Join(base, "runs"), nil, nil)
			entries, err := os.ReadDir(r.projectDir(base))
			if err != nil || len(entries) != 1 {
				t.Fatalf("helper record: %v %v", entries, err)
			}
			rec, err := r.readRecord(base, entries[0].Name())
			if err != nil {
				t.Fatal(err)
			}
			gate := filepath.Join(base, "release")
			t.Cleanup(func() { completionWrite(t, gate, "release"); waitRun(t, r, base, rec.Id); waitRunsIdle(t, r) })
			completionPoll(t, func() bool { _, err := os.Stat(gate + ".ready"); return err == nil })
			if finishBeforeRestart {
				completionWrite(t, gate, "release")
				completionPoll(t, func() bool { _, ok := r.completion(rec); return ok })
			} else if current := r.List(base)[0]; current.State != RunStateRunning || current.Exit != nil {
				t.Fatalf("restart lost live command: %+v", current)
			}
			completionWrite(t, gate, "release")
			ended := waitRun(t, r, base, rec.Id)
			if ended.State != RunStateFailure || ended.Exit == nil || *ended.Exit != 7 {
				t.Fatalf("recovered output instead of real result: %+v", ended)
			}
		})
	}
}
