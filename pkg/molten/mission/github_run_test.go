// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

type recordedCall struct {
	dir  string
	args string
}

type ghRecorder struct {
	lock    sync.Mutex
	calls   []recordedCall
	outputs map[string]string
	fails   map[string]error
}

func (r *ghRecorder) record(dir string, args string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.calls = append(r.calls, recordedCall{dir: dir, args: args})
}

func (r *ghRecorder) runner() Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		line := name + " " + strings.Join(args, " ")
		r.record(dir, line)
		if err, ok := r.fails[line]; ok {
			return nil, err
		}
		return []byte(r.outputs[line]), nil
	}
}

func TestReadGithubRunLogFailedStepsFirst(t *testing.T) {
	dir := t.TempDir()
	rec := &ghRecorder{outputs: map[string]string{
		"gh run view 42 --log-failed": "build\tstep\tboom\n",
		"gh run view 42 --log":        "everything\n",
	}}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	log, err := c.ReadGithubRunLog(GithubRunRequest{Dir: dir, RunId: 42, Failed: true})
	if err != nil {
		t.Fatal(err)
	}
	if log.Text != "build\tstep\tboom\n" || !log.FailedOnly || log.Truncated {
		t.Fatalf("log = %+v", log)
	}
	if len(rec.calls) != 1 || rec.calls[0].dir != dir {
		t.Fatalf("calls = %+v", rec.calls)
	}
}

func TestReadGithubRunLogFallsBackToTheWholeLog(t *testing.T) {
	rec := &ghRecorder{outputs: map[string]string{"gh run view 7 --log": "all steps\n"}}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	log, err := c.ReadGithubRunLog(GithubRunRequest{Dir: t.TempDir(), RunId: 7, Failed: true})
	if err != nil {
		t.Fatal(err)
	}
	if log.Text != "all steps\n" || log.FailedOnly {
		t.Fatalf("log = %+v", log)
	}
	passed, err := c.ReadGithubRunLog(GithubRunRequest{Dir: t.TempDir(), RunId: 7})
	if err != nil || passed.Text != "all steps\n" {
		t.Fatalf("passed run: %+v, %v", passed, err)
	}
	if rec.calls[len(rec.calls)-1].args != "gh run view 7 --log" {
		t.Fatalf("a run that did not fail reads the whole log: %+v", rec.calls)
	}
}

func TestReadGithubRunLogKeepsTheTail(t *testing.T) {
	long := strings.Repeat("early line\n", maxGithubRunLog/8) + "the failing line\n"
	rec := &ghRecorder{outputs: map[string]string{"gh run view 9 --log": long}}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	log, err := c.ReadGithubRunLog(GithubRunRequest{Dir: t.TempDir(), RunId: 9})
	if err != nil {
		t.Fatal(err)
	}
	if !log.Truncated || len(log.Text) > maxGithubRunLog || !strings.HasSuffix(log.Text, "the failing line\n") {
		t.Fatalf("truncated=%v len=%d", log.Truncated, len(log.Text))
	}
	if !strings.HasPrefix(log.Text, "early line\n") {
		t.Fatalf("the tail starts on a whole line: %q", log.Text[:20])
	}
}

func TestReadGithubRunLogError(t *testing.T) {
	rec := &ghRecorder{fails: map[string]error{"gh run view 5 --log": errors.New("gh: run 5 not found")}}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	if _, err := c.ReadGithubRunLog(GithubRunRequest{Dir: t.TempDir(), RunId: 5}); err == nil {
		t.Fatal("gh's error should reach the panel")
	}
}

func TestGithubRunRequestChecks(t *testing.T) {
	rec := &ghRecorder{}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	if _, err := c.ReadGithubRunLog(GithubRunRequest{Dir: "relative", RunId: 1}); err == nil {
		t.Fatal("a relative folder is refused")
	}
	if err := c.RerunGithubRun(GithubRunRequest{Dir: t.TempDir(), RunId: 0}); err == nil {
		t.Fatal("a run id of 0 is refused")
	}
	if len(rec.calls) != 0 {
		t.Fatalf("nothing runs on a refused request: %+v", rec.calls)
	}
}

func TestRerunGithubRun(t *testing.T) {
	rec := &ghRecorder{}
	c := MakeCollector(t.TempDir(), rec.runner(), nil)
	dir := t.TempDir()
	if err := c.RerunGithubRun(GithubRunRequest{Dir: dir, RunId: 12, Failed: true}); err != nil {
		t.Fatal(err)
	}
	if err := c.RerunGithubRun(GithubRunRequest{Dir: dir, RunId: 13}); err != nil {
		t.Fatal(err)
	}
	if len(rec.calls) != 2 || rec.calls[0].args != "gh run rerun 12 --failed" || rec.calls[1].args != "gh run rerun 13" {
		t.Fatalf("calls = %+v", rec.calls)
	}
}

func TestGithubRunRouteRerunOnlyFromAWindow(t *testing.T) {
	rec := &ghRecorder{outputs: map[string]string{"gh run view 3 --log": "ok\n"}}
	l := &routeLink{collector: MakeCollector(t.TempDir(), rec.runner(), nil)}
	req := map[string]any{"dir": t.TempDir(), "runid": 3}
	if _, err := l.handle(GithubRunRerunCommand, "proc:term", req); err == nil {
		t.Fatal("a terminal cannot start a GitHub run again")
	}
	if len(rec.calls) != 0 {
		t.Fatalf("calls = %+v", rec.calls)
	}
	if _, err := l.handle(GithubRunRerunCommand, wshutil.RoutePrefix_Tab+"t1", req); err != nil {
		t.Fatal(err)
	}
	out, err := l.handle(GithubRunLogCommand, "proc:term", req)
	if err != nil {
		t.Fatal(err)
	}
	if log, ok := out.(GithubRunLog); !ok || log.Text != "ok\n" {
		t.Fatalf("log = %#v", out)
	}
	if rec.calls[0].args != "gh run rerun 3" {
		t.Fatalf("calls = %+v", rec.calls)
	}
}
