// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const releasePipeline = `{"schema":1,"name":"fixture","release":{
	"rc":[
		{"id":"warm","title":"Warm","phase":"prepare","cwd":"sub","env":{"WHO":"it's me"},"run":"echo warm {tag} $WHO in $(basename $PWD)"},
		{"id":"promote","title":"Promote","phase":"prepare","run":"echo promote {version}"},
		{"id":"cut","title":"Cut","phase":"cut","run":"touch cut-ran"}],
	"public":[
		{"id":"first","title":"First","run":"echo first {tag}"},
		{"id":"second","title":"Second","run":"touch second-ran"}]}}`

func makeReleaseFixture(t *testing.T, pipeline string) (*Runs, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runs use /bin/sh")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.MkdirAll(filepath.Join(dir, "sub"), 0755)
	os.WriteFile(filepath.Join(dir, "sub", "keep"), nil, 0644)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(pipeline), 0644)
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	r.git = plainRunner
	return r, dir
}

func startRelease(t *testing.T, r *Runs, dir string, channel string, tag string) ReleaseStartResult {
	t.Helper()
	res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: channel, Tag: tag})
	if err != nil {
		t.Fatal(err)
	}
	if res.Untrusted != nil {
		if err := r.GrantTrust(dir, res.Untrusted.Hash); err != nil {
			t.Fatal(err)
		}
		if res, err = r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: channel, Tag: tag}); err != nil {
			t.Fatal(err)
		}
	}
	if res.Run == nil || res.Session == nil {
		t.Fatalf("no release started: %+v", res)
	}
	return res
}

func TestReleasePreparationSteps(t *testing.T) {
	steps := []molten.PipelineStep{{Id: "a", Phase: "prepare"}, {Id: "b", Phase: "cut"}, {Id: "c", Phase: "prepare"}}
	if got := molten.ReleasePreparation(steps); len(got) != 2 || got[0].Id != "a" || got[1].Id != "c" {
		t.Fatalf("the prepare phase: %+v", got)
	}
	if got := molten.ReleasePreparation([]molten.PipelineStep{{Id: "a"}, {Id: "b"}}); len(got) != 1 || got[0].Id != "a" {
		t.Fatalf("no phase declared, the first step: %+v", got)
	}
	if got := molten.ReleasePreparation([]molten.PipelineStep{{Id: "a", Phase: "cut"}}); len(got) != 0 {
		t.Fatalf("no preparation declared: %+v", got)
	}
}

func TestStartReleaseRunsThePreparationAndRecordsTheSession(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	res := startRelease(t, r, dir, ReleaseChannelRc, "v1.2.0-3")
	if res.Session.Version != "1.2.0" || res.Session.Channel != ReleaseChannelRc || res.Run.Kind != RunKindRelease {
		t.Fatalf("session: %+v run: %+v", res.Session, res.Run)
	}
	rec := waitRun(t, r, dir, res.Run.Id)
	if rec.State != RunStateSuccess || strings.Join(rec.Phases, ",") != "warm,promote" {
		t.Fatalf("preparation: %+v", rec)
	}
	chunk, _ := r.ReadLog(dir, rec.Id, 0)
	if !strings.Contains(chunk.Text, "warm v1.2.0-3 it's me in sub") || !strings.Contains(chunk.Text, "promote 1.2.0") {
		t.Fatalf("log: %q", chunk.Text)
	}
	if _, err := os.Stat(filepath.Join(dir, "cut-ran")); err == nil {
		t.Fatal("a later phase must wait for its click")
	}
	session, err := r.ReleaseSessionOf(dir)
	if err != nil || session == nil || session.Tag != "v1.2.0-3" {
		t.Fatalf("session kept: %+v %v", session, err)
	}
	if _, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelPublic, Tag: "v1.2.0"}); err == nil || !strings.Contains(err.Error(), "already on its way: v1.2.0-3") {
		t.Fatalf("a second release is refused: %v", err)
	}
	if err := r.EndRelease(dir); err != nil {
		t.Fatal(err)
	}
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		t.Fatalf("ended: %+v", session)
	}
	public := startRelease(t, r, dir, ReleaseChannelPublic, "v1.2.0")
	rec = waitRun(t, r, dir, public.Run.Id)
	if _, err := os.Stat(filepath.Join(dir, "second-ran")); err == nil || strings.Join(rec.Phases, ",") != "first" {
		t.Fatalf("without phases only the first step runs: %+v", rec)
	}
}

func TestStartReleaseRefusals(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.0.0-1"})
	if err != nil || res.Untrusted == nil || res.Session != nil {
		t.Fatalf("trust first: %+v %v", res, err)
	}
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		t.Fatal("nothing is recorded before the trust")
	}
	r.GrantTrust(dir, res.Untrusted.Hash)
	gitIn(t, dir, "tag", "v1.0.0-1")
	cases := map[string]ReleaseStartRequest{
		"not a release channel":     {Channel: "beta", Tag: "v1.0.0-1"},
		"not a release tag":         {Channel: ReleaseChannelRc, Tag: "1.0.0-1"},
		"public release's tag":      {Channel: ReleaseChannelRc, Tag: "v1.0.0"},
		"release candidate's tag":   {Channel: ReleaseChannelPublic, Tag: "v1.0.0-2"},
		"already tagged":            {Channel: ReleaseChannelRc, Tag: "v1.0.0-1"},
		"must be an absolute path":  {Channel: ReleaseChannelRc, Tag: "v1.0.0-2"},
		"not a release tag (vX.Y.Z": {Channel: ReleaseChannelRc, Tag: "v1.0-2"},
	}
	for want, req := range cases {
		if want != "must be an absolute path" {
			req.Dir = dir
		}
		if _, err := r.StartRelease(req); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%+v: want %q, got %v", req, want, err)
		}
	}
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		t.Fatalf("a refused release records nothing: %+v", session)
	}
}

func TestReleaseStepPhasesAreChecked(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","release":{
		"rc":[{"id":"a","phase":"ship","run":"true"}],"public":[{"id":"b","run":"true"}]}}`), 0644)
	report := molten.ValidatePipeline(dir)
	if report.Valid || !strings.Contains(strings.Join(report.Errors, "\n"), `phase "ship" is not one of prepare, cut, build, publish, back`) {
		t.Fatalf("errors: %v", report.Errors)
	}
	if !strings.Contains(strings.Join(report.Warnings, "\n"), "release.public: no step declares its phase") {
		t.Fatalf("warnings: %v", report.Warnings)
	}
}
