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

// SaaSFoundryAI's v1.1.0 (#1091): the manual cut step before the pull-request flow's steps, with backticks in its
// instructions.
const prFlowManualPipeline = `{"schema":1,"name":"fixture","release":{
	"public":[
		{"id":"prepare","title":"Bump on rc-{version}","phase":"prepare","run":"echo prepared {tag}"},
		{"id":"changelog-en","title":"Write the [{version}] section of docs/changelog.md","phase":"cut","manual":"In the release worktree (on rc-{version}), write the [{version}] section."},
		{"id":"agents-version","title":"Set the current version line of AGENTS.md to {version}","phase":"cut","manual":"In the release worktree (../SaaSFoundry-release, on rc-{version}), in AGENTS.md (Important Context), set the line to '- Current version: {version} (npm package ` + "`saasfoundryai-cli`" + `)'. It still reads 1.0.0-beta."},
		{"id":"open-pr","title":"Commit the release on rc-{version} and open its pull request to master","phase":"cut","confirm":"Pushes rc-{version}.","run":"touch open-pr-ran"},
		{"id":"tag","title":"Tag","phase":"cut","confirm":"{tag} is public once pushed.","run":"touch tag-ran"}]}}`

func TestManualCutStepIsRecordedWhileTheCommandsWaitForTrust(t *testing.T) {
	r, dir := makeReleaseFixture(t, prFlowManualPipeline)
	res := startRelease(t, r, dir, ReleaseChannelPublic, "v1.1.0")
	waitRun(t, r, dir, res.Run.Id)
	if step, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"}); err != nil || step.Run == nil {
		t.Fatalf("%+v %v", step, err)
	}
	// The pipeline's commands changed since they were trusted: marking a step done runs nothing, so it is recorded.
	changed := strings.Replace(prFlowManualPipeline, "touch open-pr-ran", "touch open-pr-ran-again", 1)
	if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(changed), 0644); err != nil {
		t.Fatal(err)
	}
	step, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "agents-version"})
	if err != nil || step.Run == nil || step.Untrusted != nil {
		t.Fatalf("the manual step must be recorded: %+v %v", step, err)
	}
	if step.Run.State != RunStateSuccess || step.Run.Title != "Set the current version line of AGENTS.md to 1.1.0" {
		t.Fatalf("run: %+v", step.Run)
	}
	chunk, _ := r.ReadLog(dir, step.Run.Id, 0)
	if !strings.Contains(chunk.Text, "on rc-1.1.0") || !strings.Contains(chunk.Text, "1.1.0 (npm package `saasfoundryai-cli`)") || strings.Contains(chunk.Text, "{version}") {
		t.Fatalf("log: %q", chunk.Text)
	}
	facts, _ := r.ReleaseFactsOf(dir)
	if facts.Steps["agents-version"].State != RunStateSuccess {
		t.Fatalf("facts: %+v", facts.Steps)
	}
	next, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "open-pr"})
	if err != nil || next.Untrusted == nil || next.Run != nil {
		t.Fatalf("a step that runs a command still asks for trust: %+v %v", next, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "open-pr-ran-again")); err == nil {
		t.Fatal("nothing ran")
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
