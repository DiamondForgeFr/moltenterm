// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// SaaSFoundryAI's v1.1.0 (#1095): the changelog steps were confirmed while neither changelog had its section yet.
const checkedManualPipeline = `{"schema":1,"name":"fixture","release":{
	"public":[
		{"id":"prepare","title":"Prepare","phase":"prepare","run":"echo prepared {tag}"},
		{"id":"changelog-en","title":"Write the [{version}] section","phase":"cut","manual":"Write the [{version}] section of docs/changelog.md.","check":{"path":"docs/changelog.md","contains":"## [{version}]"}},
		{"id":"agents-version","title":"Set the version line","phase":"cut","manual":"Set the version line of AGENTS.md.","check":{"path":"AGENTS.md","contains":"- Current version: {version}"}},
		{"id":"tag","title":"Tag","phase":"cut","confirm":"{tag} is public once pushed.","run":"touch tag-ran"}]}}`

func TestManualStepCheckRecordsNothingUntilItHoldsOrIsConfirmed(t *testing.T) {
	r, dir := makeReleaseFixture(t, checkedManualPipeline)
	res := startRelease(t, r, dir, ReleaseChannelPublic, "v1.1.0")
	waitRun(t, r, dir, res.Run.Id)

	missing, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || missing.Run != nil || missing.Unproved == nil {
		t.Fatalf("a missing changelog proves nothing: %+v %v", missing, err)
	}
	if !missing.Unproved.Missing || missing.Unproved.Path != "docs/changelog.md" || missing.Unproved.Contains != "## [1.1.0]" || strings.HasSuffix(missing.Unproved.Dir, "-release") {
		t.Fatalf("unproved: %+v", missing.Unproved)
	}

	os.MkdirAll(filepath.Join(dir, "docs"), 0755)
	os.WriteFile(filepath.Join(dir, "docs", "changelog.md"), []byte("# Changelog\n\n## [1.0.0]\n"), 0644)
	lacking, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || lacking.Run != nil || lacking.Unproved == nil || lacking.Unproved.Missing {
		t.Fatalf("a changelog without the section proves nothing: %+v %v", lacking, err)
	}
	if facts, _ := r.ReleaseFactsOf(dir); facts.Steps["changelog-en"].RunId != "" {
		t.Fatalf("nothing is recorded: %+v", facts.Steps)
	}

	os.WriteFile(filepath.Join(dir, "docs", "changelog.md"), []byte("# Changelog\n\n## [1.1.0]\n\n## [1.0.0]\n"), 0644)
	proved, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || proved.Run == nil || proved.Unproved != nil || proved.Run.State != RunStateSuccess {
		t.Fatalf("the section proves the step: %+v %v", proved, err)
	}

	os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("- Current version: 1.0.0-beta\n"), 0644)
	forced, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "agents-version", Force: true})
	if err != nil || forced.Run == nil || forced.Unproved != nil {
		t.Fatalf("confirmed anyway, it is recorded: %+v %v", forced, err)
	}
	chunk, _ := r.ReadLog(dir, forced.Run.Id, 0)
	if !strings.Contains(chunk.Text, ManualStepForcedLine) || !strings.Contains(chunk.Text, `"- Current version: 1.1.0"`) {
		t.Fatalf("the log says it was confirmed although the check failed: %q", chunk.Text)
	}
	if _, err := os.Stat(filepath.Join(dir, "tag-ran")); err == nil {
		t.Fatal("nothing ran")
	}
}

func TestManualStepCheckReadsTheReleaseWorktree(t *testing.T) {
	r, dir := makeReleaseFixture(t, checkedManualPipeline)
	wt := dir + "-release"
	gitIn(t, dir, "worktree", "add", "-q", "-b", "rc-1.1.0", wt)
	t.Cleanup(func() { os.RemoveAll(wt) })
	os.MkdirAll(filepath.Join(wt, "docs"), 0755)
	os.WriteFile(filepath.Join(wt, "docs", "changelog.md"), []byte("## [1.1.0]\n"), 0644)
	res := startRelease(t, r, dir, ReleaseChannelPublic, "v1.1.0")
	waitRun(t, r, dir, res.Run.Id)
	step, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || step.Run == nil || step.Unproved != nil {
		t.Fatalf("the changelog written in the release worktree proves the step: %+v %v", step, err)
	}
}

func TestManualStepCheckValidation(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	bad := `{"schema":1,"name":"P","release":{"rc":[
		{"id":"p","phase":"prepare","run":"true"},
		{"id":"a","phase":"cut","manual":"by hand","check":{"path":"../outside.md","contains":"x"}},
		{"id":"b","phase":"cut","manual":"by hand","check":{"path":"CHANGELOG.md","contains":" "}},
		{"id":"c","phase":"cut","confirm":"x","run":"true","check":{"path":"CHANGELOG.md","contains":"x"}}]}}`
	report := molten.ValidatePipelineData(dir, []byte(bad))
	all := strings.Join(report.Errors, "\n")
	for _, want := range []string{"release.rc[1] (a): check.path must name a file of the project", "release.rc[2] (b): check.contains is empty", "release.rc[3] (c): only a manual step declares a check"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q in:\n%s", want, all)
		}
	}
	good := `{"schema":1,"name":"P","release":{"rc":[
		{"id":"p","phase":"prepare","run":"true"},
		{"id":"m","phase":"cut","manual":"by hand","check":{"path":"docs/{tag}.md","contains":"## [{version}]"}},
		{"id":"d","phase":"cut","confirm":"x","run":"true"}]}}`
	if report := molten.ValidatePipelineData(dir, []byte(good)); !report.Valid {
		t.Fatalf("%v", report.Errors)
	}
}

func TestStartingAReleaseSaysWhenThePipelineIsUncommitted(t *testing.T) {
	r, dir := makeReleaseFixture(t, checkedManualPipeline)
	trusted := startTrusted(t, r, dir)
	changed := strings.Replace(checkedManualPipeline, `"title":"Tag"`, `"title":"Tag it"`, 1)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(changed), 0644)
	res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelPublic, Tag: "v1.1.0"})
	if err != nil || res.PipelineDrift == nil || !res.PipelineDrift.Uncommitted || res.Session != nil || res.Run != nil {
		t.Fatalf("an uncommitted pipeline starts nothing: %+v %v (trusted %v)", res, err, trusted)
	}
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		t.Fatalf("no session: %+v", session)
	}
	forced, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelPublic, Tag: "v1.1.0", Force: true})
	if err != nil || forced.Session == nil || forced.PipelineDrift != nil {
		t.Fatalf("confirmed, it starts: %+v %v", forced, err)
	}
	waitRun(t, r, dir, forced.Run.Id)
}

func TestStartingAReleaseSaysWhenThePipelineDiffersFromTheTrunk(t *testing.T) {
	r, dir := makeReleaseFixture(t, checkedManualPipeline)
	startTrusted(t, r, dir)
	// The trunk moved on (#1091 finding 1: origin/develop held the release block the checkout lacked).
	gitIn(t, dir, "checkout", "-q", "-b", "feature/x")
	changed := strings.Replace(checkedManualPipeline, `"title":"Tag"`, `"title":"Tag it"`, 1)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(changed), 0644)
	gitIn(t, dir, "commit", "-q", "-am", "pipeline")
	res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelPublic, Tag: "v1.1.0"})
	if err != nil || res.PipelineDrift == nil || res.PipelineDrift.Uncommitted || res.PipelineDrift.Base != "develop" {
		t.Fatalf("a pipeline other than the trunk's starts nothing: %+v %v", res, err)
	}
}

func TestReleaseFactsReadTheLastFormatWord(t *testing.T) {
	pipeline := `{"schema":1,"name":"fixture","release":{"public":[
		{"id":"prepare","title":"Prepare","phase":"prepare","run":"echo '▶ format: formatted prettier' && echo '▶ format: failed node_modules/.bin/prettier --write -- '\\''releases/v1.1.0.md'\\''' && echo done"},
		{"id":"tag","title":"Tag","phase":"cut","confirm":"{tag} is public once pushed.","run":"echo '▶ format: none'"}]}}`
	r, dir := makeReleaseFixture(t, pipeline)
	res := startRelease(t, r, dir, ReleaseChannelPublic, "v1.1.0")
	waitRun(t, r, dir, res.Run.Id)
	facts, _ := r.ReleaseFactsOf(dir)
	if facts.Format == nil || facts.Format.State != "failed" || facts.Format.Command != "node_modules/.bin/prettier --write -- 'releases/v1.1.0.md'" || facts.Format.Step != ReleasePreparationStepId {
		t.Fatalf("format: %+v", facts.Format)
	}
	for _, line := range facts.Preparation.Tail {
		if strings.Contains(line, "▶ format:") {
			t.Fatalf("the marker is not shown in the tail: %q", facts.Preparation.Tail)
		}
	}
	step, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "tag"})
	if err != nil || step.Run == nil {
		t.Fatalf("%+v %v", step, err)
	}
	waitRun(t, r, dir, step.Run.Id)
	if facts, _ := r.ReleaseFactsOf(dir); facts.Format == nil || facts.Format.State != "none" || facts.Format.Step != "tag" {
		t.Fatalf("the newest run's word wins: %+v", facts.Format)
	}
}

// startTrusted trusts the fixture's commands without starting anything.
func startTrusted(t *testing.T, r *Runs, dir string) bool {
	t.Helper()
	p, err := validPipelineAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	if untrusted := r.untrustedIn(dir, p); untrusted != nil {
		if err := r.GrantTrust(dir, untrusted.Hash); err != nil {
			t.Fatal(err)
		}
		return true
	}
	return false
}
