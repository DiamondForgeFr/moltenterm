// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func writePipeline(t *testing.T, dir string, builds string) {
	t.Helper()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	content := `{"schema":1,"name":"fixture","builds":[` + builds + `]}`
	if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func makeRunsFixture(t *testing.T, builds string) (*Runs, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	dir := t.TempDir()
	writePipeline(t, dir, builds)
	data := t.TempDir()
	return MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil), dir
}

func waitRun(t *testing.T, r *Runs, dir string, runId string) RunRecord {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, rec := range r.List(dir) {
			if rec.Id == runId && rec.State != RunStateRunning {
				return rec
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("run %s did not finish", runId)
	return RunRecord{}
}

func trustAndStart(t *testing.T, r *Runs, dir string, id string) RunRecord {
	t.Helper()
	res, err := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: id})
	if err != nil {
		t.Fatal(err)
	}
	if res.Untrusted != nil {
		if err := r.GrantTrust(dir, res.Untrusted.Hash); err != nil {
			t.Fatal(err)
		}
		res, err = r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: id})
		if err != nil {
			t.Fatal(err)
		}
	}
	if res.Run == nil {
		t.Fatalf("no run started: %+v", res)
	}
	return *res.Run
}

func TestRunNeedsTrustFirst(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo hi","artifact":"~/Apps/Fixture.app"}`)
	res, err := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: "gold"})
	if err != nil || res.Run != nil || res.Untrusted == nil || len(res.Untrusted.Commands) != 1 || res.Untrusted.Commands[0].Run != "echo hi" {
		t.Fatalf("first run must ask for trust: %+v, %v", res, err)
	}
	rec := trustAndStart(t, r, dir, "gold")
	if !strings.HasSuffix(rec.Artifact, "/Apps/Fixture.app") || strings.HasPrefix(rec.Artifact, "~") {
		t.Fatalf("artifact not expanded: %q", rec.Artifact)
	}
	waitRun(t, r, dir, rec.Id)
	// Changing a command asks again; changing a title does not.
	writePipeline(t, dir, `{"id":"gold","title":"Renamed","run":"echo hi","artifact":"~/Apps/Fixture.app"}`)
	if res, _ := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: "gold"}); res.Untrusted != nil {
		t.Fatal("a new title must not ask for trust again")
	}
	writePipeline(t, dir, `{"id":"gold","title":"Gold","run":"echo changed"}`)
	if res, _ := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: "gold"}); res.Untrusted == nil {
		t.Fatal("a changed command must ask for trust again")
	}
}

func TestArtifactPath(t *testing.T) {
	if got := artifactPath("/p", "dist/App.app"); got != "/p/dist/App.app" {
		t.Errorf("relative artifact: %q", got)
	}
	if got := artifactPath("/p", "/abs/App.app"); got != "/abs/App.app" {
		t.Errorf("absolute artifact: %q", got)
	}
	if got := artifactPath("/p", ""); got != "" {
		t.Errorf("no artifact: %q", got)
	}
}

func TestRunSucceedsWithPhasesAndLog(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"echo '▶ phase: build'; echo working; echo '▶ phase: deliver'; pwd"}`)
	rec := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	if rec.State != RunStateSuccess || rec.Exit == nil || *rec.Exit != 0 || strings.Join(rec.Phases, ",") != "build,deliver" {
		t.Fatalf("finished run: %+v", rec)
	}
	chunk, err := r.ReadLog(dir, rec.Id, 0)
	if err != nil || !strings.Contains(chunk.Text, "working") || !strings.Contains(chunk.Text, "exit=0") || chunk.Size != int64(len(chunk.Text)) {
		t.Fatalf("log: %+v, %v", chunk, err)
	}
	resolved, _ := filepath.EvalSymlinks(dir)
	if !strings.Contains(chunk.Text, resolved) && !strings.Contains(chunk.Text, dir) {
		t.Fatalf("the run must start in the project folder: %q", chunk.Text)
	}
	if _, err := r.ReadLog(dir, "../x", 0); err == nil {
		t.Fatal("a run id with a path must be refused")
	}
}

func TestRunFailureAndExclusivity(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"slow","run":"sleep 30"},{"id":"bad","run":"exit 3"}`)
	slow := trustAndStart(t, r, dir, "slow")
	if _, err := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: "bad"}); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a second build while one runs must be refused: %v", err)
	}
	if err := r.Cancel(dir, slow.Id); err != nil {
		t.Fatal(err)
	}
	if rec := waitRun(t, r, dir, slow.Id); rec.State != RunStateCancelled {
		t.Fatalf("cancelled run: %+v", rec)
	}
	bad := waitRun(t, r, dir, trustAndStart(t, r, dir, "bad").Id)
	if bad.State != RunStateFailure || bad.Exit == nil || *bad.Exit != 3 {
		t.Fatalf("failed run: %+v", bad)
	}
}

func TestRunLostAfterRestart(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	runDir := filepath.Join(r.projectDir(dir), "20260101-000000-aaaaaa")
	os.MkdirAll(runDir, 0700)
	os.WriteFile(filepath.Join(runDir, LogFileName), []byte("half a log\n"), 0600)
	r.writeRecord(RunRecord{Id: "20260101-000000-aaaaaa", Dir: dir, Kind: RunKindBuild, StepId: "gold", State: RunStateRunning, Pid: 999999, Phases: []string{}})
	runs := r.List(dir)
	if len(runs) != 1 || runs[0].State != RunStateLost {
		t.Fatalf("a run whose process is gone without an exit code is lost: %+v", runs)
	}
}

func TestRunRequestsAreChecked(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","run":"true"}`)
	if _, err := r.Start(RunRequest{Dir: dir, Kind: "rc", Id: "cut"}); err == nil {
		r.GrantTrust(dir, CommandsHash(PipelineCommands(molten.ValidatePipeline(dir).Pipeline)))
		if _, err := r.Start(RunRequest{Dir: dir, Kind: "rc", Id: "cut"}); err == nil {
			t.Fatal("release steps are not run yet")
		}
	}
	r.GrantTrust(dir, CommandsHash(PipelineCommands(molten.ValidatePipeline(dir).Pipeline)))
	if _, err := r.Start(RunRequest{Dir: dir, Kind: RunKindBuild, Id: "nope"}); err == nil {
		t.Fatal("an undeclared build must be refused")
	}
	if _, err := r.Start(RunRequest{Dir: "relative", Kind: RunKindBuild, Id: "gold"}); err == nil {
		t.Fatal("a relative folder must be refused")
	}
	if !isWindowSource("tab:abc") || isWindowSource("proc:abc") || isWindowSource("") {
		t.Fatal("only windows may grant trust")
	}
}
