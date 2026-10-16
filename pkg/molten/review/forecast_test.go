// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/forecast"
)

const forecastWait = time.Minute

func forecastTestGit(ctx context.Context, input []byte, env []string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com"), env...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, stderr.String())
	}
	return stdout.Bytes(), nil
}

func fgit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), forecastWait)
	defer cancel()
	out, err := forecastTestGit(ctx, nil, nil, append([]string{"-C", dir}, args...)...)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func fcommit(t *testing.T, dir string, branch string, from string, file string, content string) string {
	t.Helper()
	fgit(t, dir, "checkout", "-q", "-B", branch, from)
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, dir, "add", "-A")
	fgit(t, dir, "commit", "-q", "-m", branch)
	return fgit(t, dir, "rev-parse", "HEAD")
}

// forecastProject: pr1 and pr2 change the same line of f, pr3 adds g.
func forecastProject(t *testing.T) (string, ForecastRequest) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	fgit(t, dir, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, dir, "add", "-A")
	fgit(t, dir, "commit", "-q", "-m", "base")
	base := fgit(t, dir, "rev-parse", "HEAD")
	req := ForecastRequest{Dir: dir, Repo: "owner/name", Base: "main", BaseOid: base}
	for n, change := range []struct{ file, content string }{{"f", "a\none\nc\n"}, {"f", "a\ntwo\nc\n"}, {"g", "three\n"}} {
		head := fcommit(t, dir, fmt.Sprintf("pr%d", n+1), base, change.file, change.content)
		req.Prs = append(req.Prs, forecast.Pr{Number: n + 1, Branch: fmt.Sprintf("pr%d", n+1), HeadOid: head, Ready: true})
	}
	fgit(t, dir, "checkout", "-q", "main")
	return dir, req
}

type forecastEvents struct {
	lock sync.Mutex
	list []Forecast
}

func (e *forecastEvents) add(f Forecast) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.list = append(e.list, f)
}

func (e *forecastEvents) count() int {
	e.lock.Lock()
	defer e.lock.Unlock()
	return len(e.list)
}

func (e *forecastEvents) last() Forecast {
	e.lock.Lock()
	defer e.lock.Unlock()
	return e.list[len(e.list)-1]
}

func testForecaster(t *testing.T, upToDate string) (*Forecaster, *forecastEvents) {
	events := &forecastEvents{}
	f := MakeForecaster(ForecastEnv{
		Git:      forecastTestGit,
		StoreDir: t.TempDir(),
		Rules: func(ctx context.Context, dir, repo, base string) (string, string) {
			return forecast.MethodSquash, upToDate
		},
		Publish: events.add,
	})
	f.done = make(chan string, 16)
	// A computation still writing in the temp folders fails their removal.
	t.Cleanup(func() { waitForecastIdle(t, f) })
	return f, events
}

func waitForecastIdle(t *testing.T, f *Forecaster) {
	deadline := time.Now().Add(forecastWait)
	for time.Now().Before(deadline) {
		if !f.anyRunning() {
			return
		}
		select {
		case <-f.done:
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Errorf("the forecast kept running")
}

func (f *Forecaster) anyRunning() bool {
	f.lock.Lock()
	defer f.lock.Unlock()
	for _, state := range f.states {
		if state.running {
			return true
		}
	}
	return false
}

func waitForecastDone(t *testing.T, f *Forecaster) {
	t.Helper()
	select {
	case <-f.done:
	case <-time.After(forecastWait):
		t.Fatal("no forecast ended")
	}
}

func impactNumbers(row forecast.Row) []int {
	rtn := []int{}
	for _, impact := range row.Impacts {
		rtn = append(rtn, impact.Number)
	}
	return rtn
}

func TestForecasterAnswersAtOnceThenPublishes(t *testing.T) {
	_, req := forecastProject(t)
	f, events := testForecaster(t, UpToDateNotRequired)
	first, err := f.Get(req)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Running || first.State != "" || len(first.Rows) != 0 {
		t.Fatalf("first answer %+v, want running with no rows", first)
	}
	waitForecastDone(t, f)
	done := events.last()
	if done.State != ForecastStateReady || done.Running || done.Stale || done.Key != ForecastKey(req) {
		t.Fatalf("published %+v", done)
	}
	if done.Method != forecast.MethodSquash || done.UpToDate != UpToDateNotRequired {
		t.Errorf("method %q, uptodate %q", done.Method, done.UpToDate)
	}
	want := map[int][]int{1: {2}, 2: {1}, 3: {}}
	for _, row := range done.Rows {
		if got := impactNumbers(row); fmt.Sprint(got) != fmt.Sprint(want[row.Number]) {
			t.Errorf("#%d impacts %v, want %v", row.Number, got, want[row.Number])
		}
	}
	// The same PRs and base: the answer is the cached one, nothing runs.
	again, err := f.Get(req)
	if err != nil {
		t.Fatal(err)
	}
	if again.Running || again.Stale || again.State != ForecastStateReady || events.count() != 1 {
		t.Fatalf("same request: %+v after %d events", again, events.count())
	}
}

func TestForecasterSaysStaleWhileItRecomputes(t *testing.T) {
	dir, req := forecastProject(t)
	f, events := testForecaster(t, UpToDateUnknown)
	if _, err := f.Get(req); err != nil {
		t.Fatal(err)
	}
	waitForecastDone(t, f)
	// pr3 is pushed: it now changes f too.
	req.Prs[2].HeadOid = fcommit(t, dir, "pr3", "pr3", "f", "a\nthree\nc\n")
	moved, err := f.Get(req)
	if err != nil {
		t.Fatal(err)
	}
	if !moved.Running || !moved.Stale || moved.State != ForecastStateReady {
		t.Fatalf("after a push: %+v, want the previous forecast, stale and running", moved)
	}
	waitForecastDone(t, f)
	done := events.last()
	if done.Stale || done.Key != ForecastKey(req) {
		t.Fatalf("published %+v", done)
	}
	if done.Stats.Merges != 1 || done.Stats.Pairs != 4 || done.Stats.Reused != 2 {
		t.Errorf("only pr3's pairs are computed again: %+v", done.Stats)
	}
}

func TestForecasterRefusesBadRequests(t *testing.T) {
	f, _ := testForecaster(t, UpToDateUnknown)
	oid := strings.Repeat("a", 40)
	for i, req := range []ForecastRequest{
		{Dir: "relative", Repo: "o/n", Base: "main", BaseOid: oid},
		{Dir: "/x", Repo: "not a repo", Base: "main", BaseOid: oid},
		{Dir: "/x", Repo: "o/n", Base: "main", BaseOid: "main"},
		{Dir: "/x", Repo: "o/n", Base: "main", BaseOid: oid, Prs: []forecast.Pr{{Number: 1, Branch: "-x", HeadOid: oid}}},
	} {
		if _, err := f.Get(req); err == nil {
			t.Errorf("request %d accepted", i)
		}
	}
}

func TestForecasterTooManyPrs(t *testing.T) {
	_, req := forecastProject(t)
	for n := 10; len(req.Prs) <= MaxForecastPrs; n++ {
		req.Prs = append(req.Prs, forecast.Pr{Number: n, Branch: fmt.Sprintf("b%d", n), HeadOid: req.BaseOid})
	}
	f, events := testForecaster(t, UpToDateUnknown)
	if _, err := f.Get(req); err != nil {
		t.Fatal(err)
	}
	waitForecastDone(t, f)
	if got := events.last(); got.State != ForecastStateFailed || got.Error != ForecastErrorTooMany {
		t.Errorf("published %+v", got)
	}
}

func TestForecasterNotAGitProject(t *testing.T) {
	f, events := testForecaster(t, UpToDateUnknown)
	oid := strings.Repeat("a", 40)
	if _, err := f.Get(ForecastRequest{Dir: t.TempDir(), Repo: "o/n", Base: "main", BaseOid: oid}); err != nil {
		t.Fatal(err)
	}
	waitForecastDone(t, f)
	if got := events.last(); got.State != ForecastStateFailed || got.Error != ForecastErrorNoGit {
		t.Errorf("published %+v", got)
	}
}

func rulesGh(answers map[string]string, fails map[string]string) GhRunner {
	return func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		if len(args) == 2 && args[0] == "api" {
			if msg, ok := fails[args[1]]; ok {
				return nil, errors.New(msg)
			}
			if out, ok := answers[args[1]]; ok {
				return []byte(out), nil
			}
		}
		return nil, errors.New("gh: Not Found (HTTP 404)")
	}
}

func TestForecastRulesUpToDate(t *testing.T) {
	const repo = "o/n"
	rules := "repos/o/n/rules/branches/develop"
	checks := "repos/o/n/branches/develop/protection/required_status_checks"
	branch := "repos/o/n/branches/develop"
	cases := []struct {
		name    string
		answers map[string]string
		fails   map[string]string
		want    string
	}{
		{"ruleset strict", map[string]string{rules: `[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true}}]`}, nil, UpToDateRequired},
		{"ruleset loose, branch unprotected", map[string]string{rules: `[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false}}]`, branch: `{"protected":false}`}, nil, UpToDateNotRequired},
		{"classic strict", map[string]string{rules: `[]`, checks: `{"strict":true}`}, nil, UpToDateRequired},
		{"classic loose", map[string]string{rules: `[]`, checks: `{"strict":false}`}, nil, UpToDateNotRequired},
		{"protected, checks unreadable", map[string]string{rules: `[]`, branch: `{"protected":true}`}, nil, UpToDateUnknown},
		{"no admin rights", map[string]string{rules: `[]`}, map[string]string{checks: "gh: Forbidden (HTTP 403)"}, UpToDateUnknown},
		{"rules unreadable", map[string]string{branch: `{"protected":false}`}, map[string]string{rules: "gh: Forbidden (HTTP 403)"}, UpToDateUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := MakeMerger(MakeStore(t.TempDir()), rulesGh(c.answers, c.fails), nil)
			_, got := makeForecastRules(m).Rules(context.Background(), t.TempDir(), repo, "develop")
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}
