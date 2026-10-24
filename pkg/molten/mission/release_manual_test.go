// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const manualPipeline = `{"schema":1,"name":"fixture","release":{
	"rc":[
		{"id":"prepare","title":"Prepare","phase":"prepare","run":"echo prepared {tag}"},
		{"id":"merge-ours","title":"Merge master with -s ours","phase":"cut","manual":"git merge -s ours origin/master, then push develop"},
		{"id":"cut","title":"Cut","phase":"cut","confirm":"{tag} is public.","run":"touch cut-ran"}]}}`

func TestManualStepIsRecordedDoneWithoutRunningAnything(t *testing.T) {
	r, dir := makeReleaseFixture(t, manualPipeline)
	res := startRelease(t, r, dir, ReleaseChannelRc, "v1.2.0-1")
	waitRun(t, r, dir, res.Run.Id)
	step, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.2.0-1", Step: "merge-ours"})
	if err != nil || step.Run == nil {
		t.Fatalf("%+v %v", step, err)
	}
	if step.Run.State != RunStateSuccess || step.Run.Command != "" || step.Run.Pid != 0 {
		t.Fatalf("a manual step runs nothing and is done: %+v", step.Run)
	}
	chunk, _ := r.ReadLog(dir, step.Run.Id, 0)
	if !strings.Contains(chunk.Text, "git merge -s ours origin/master") || !strings.Contains(chunk.Text, ManualStepDoneLine) {
		t.Fatalf("log: %q", chunk.Text)
	}
	facts, _ := r.ReleaseFactsOf(dir)
	if facts.Steps["merge-ours"].State != RunStateSuccess {
		t.Fatalf("facts: %+v", facts.Steps)
	}
	if _, err := os.Stat(filepath.Join(dir, "cut-ran")); err == nil {
		t.Fatal("the next step waits for its own click")
	}
}

func TestManualStepsAreNotTrustedCommands(t *testing.T) {
	p := &molten.Pipeline{Release: &molten.PipelineRelease{Rc: []molten.PipelineStep{
		{Id: "a", PipelineCommand: molten.PipelineCommand{Run: "true"}},
		{Id: "b", Manual: "do it"},
	}}}
	commands := PipelineCommands(p)
	if len(commands) != 1 || commands[0].Id != "a" {
		t.Fatalf("%+v", commands)
	}
	changed := &molten.Pipeline{Release: &molten.PipelineRelease{Rc: []molten.PipelineStep{
		{Id: "a", PipelineCommand: molten.PipelineCommand{Run: "true"}},
		{Id: "b", Manual: "do it differently"},
	}}}
	if CommandsHash(commands) != CommandsHash(PipelineCommands(changed)) {
		t.Fatal("changing a manual step's instructions asks no trust")
	}
}

func TestManualStepValidation(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	bad := `{"schema":1,"name":"P","release":{"rc":[
		{"id":"a","phase":"prepare","manual":"by hand"},
		{"id":"b","phase":"cut","manual":"by hand","run":"true"},
		{"id":"c","manual":"by hand","notes":true},
		{"id":"d","phase":"cut","confirm":"x","run":"true"}]}}`
	report := molten.ValidatePipelineData(dir, []byte(bad))
	all := strings.Join(report.Errors, "\n")
	for _, want := range []string{"release.rc[0] (a): a manual step cannot be in the prepare phase", "release.rc[1] (b): a manual step has no run", "release.rc[2] (c): a manual step cannot rewrite the notes"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q in:\n%s", want, all)
		}
	}
	good := `{"schema":1,"name":"P","release":{"rc":[
		{"id":"p","phase":"prepare","run":"true"},
		{"id":"m","phase":"cut","manual":"by hand"},
		{"id":"d","phase":"cut","confirm":"x","run":"true"}]}}`
	if report := molten.ValidatePipelineData(dir, []byte(good)); !report.Valid {
		t.Fatalf("%v", report.Errors)
	}
}

func TestPendingApprovalFromTheStepLog(t *testing.T) {
	log := []byte("Started\n▶ approval: github-pages https://github.com/o/r/actions/runs/9\nwaits\n")
	if a := pendingApproval(log); a == nil || a.Environment != "github-pages" || a.Url != "https://github.com/o/r/actions/runs/9" {
		t.Fatalf("%+v", a)
	}
	if a := pendingApproval(append(log, []byte("▶ approved: github-pages\n")...)); a != nil {
		t.Fatalf("approved: %+v", a)
	}
}

func TestWaitingApprovalsOfTagRuns(t *testing.T) {
	var asked []string
	r := &Runs{git: func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		asked = append(asked, name+" "+strings.Join(args, " "))
		return []byte(`[{"environment":{"name":"npm-production"}}]`), nil
	}}
	runs := []ReleaseGhRun{
		{DatabaseId: 7, WorkflowName: "Publish", Status: "waiting", Url: "https://github.com/DiamondForgeFr/SaasFoundryAI/actions/runs/7"},
		{DatabaseId: 8, WorkflowName: "Tests", Status: "in_progress", Url: "https://github.com/DiamondForgeFr/SaasFoundryAI/actions/runs/8"},
	}
	got := r.waitingApprovals(context.Background(), "/x", runs)
	if len(got) != 1 || got[0].Environment != "npm-production" || got[0].Workflow != "Publish" {
		t.Fatalf("%+v", got)
	}
	if len(asked) != 1 || asked[0] != "gh api repos/DiamondForgeFr/SaasFoundryAI/actions/runs/7/pending_deployments" {
		t.Fatalf("%v", asked)
	}
}
