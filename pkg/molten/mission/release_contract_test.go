// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The release contract (#230): every declared step runs, whatever its id, and a Notulia-shaped pipeline, with or
// without phases, cuts a release candidate and a public release end to end against a local origin.

const notGithubAnswer = "gh run list: failed to determine base repo: none of the git remotes configured for this repository point to a known GitHub host."

// gh answers as it does in a folder whose remotes are not on GitHub.
func offGithub(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name == "gh" {
		return nil, errors.New(notGithubAnswer)
	}
	return plainRunner(ctx, dir, name, args...)
}

func fixtureScript(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("testdata", "release-fixture", "make-fixture.sh"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

// makeNotuliaFixture makes <tmp>/origin.git and its clone <tmp>/fixture through the fixture's own script.
func makeNotuliaFixture(t *testing.T, variant string) (*Runs, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fixture's steps are shell scripts")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is not installed")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(fixtureScript(t), base, variant).CombinedOutput()
	if err != nil {
		t.Fatalf("make-fixture: %v\n%s", err, out)
	}
	dir := filepath.Join(base, "fixture")
	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	r.git = offGithub
	return r, dir
}

func mustFacts(t *testing.T, r *Runs, dir string) ReleaseFacts {
	t.Helper()
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}

func stepState(facts ReleaseFacts, id string) string {
	fact, ok := facts.Steps[id]
	if !ok {
		return ""
	}
	return fact.State
}

func runFailingStep(t *testing.T, r *Runs, dir string, tag string, step string) RunRecord {
	t.Helper()
	res, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: tag, Step: step})
	if err != nil || res.Run == nil {
		t.Fatalf("step %s: %+v %v", step, res, err)
	}
	return waitRun(t, r, dir, res.Run.Id)
}

// cutRelease follows one release from its start to its return to develop, in the order the Project tab offers it.
func cutRelease(t *testing.T, r *Runs, dir string, channel string, tag string, phased bool) {
	t.Helper()
	start := startRelease(t, r, dir, channel, tag)
	if rec := waitRun(t, r, dir, start.Run.Id); rec.State != RunStateSuccess {
		t.Fatalf("%s: the preparation failed: %+v", tag, rec)
	}
	facts := mustFacts(t, r, dir)
	if facts.Preparation == nil || facts.Preparation.State != RunStateSuccess || len(facts.Steps) != 0 {
		t.Fatalf("%s: the preparation is apart from the declared steps: %+v", tag, facts)
	}
	want := "warm-cache"
	if phased {
		want = "warm-cache,promote"
	}
	if got := strings.Join(facts.Preparation.Phases, ","); got != want {
		t.Fatalf("%s: prepared %q, want %q", tag, got, want)
	}
	cut := []string{"prepare", "finalize"}
	if !phased {
		cut = []string{"promote", "prepare", "finalize"}
	}
	for _, step := range cut {
		if step == "finalize" {
			facts = mustFacts(t, r, dir)
			notes := filepath.Join(filepath.Dir(dir), "fixture-release", "releases", tag+".md")
			if facts.Notes != notes || !facts.NotesDrafted {
				t.Fatalf("%s: the notes drafted in the release worktree: %q drafted %v", tag, facts.Notes, facts.NotesDrafted)
			}
			if err := r.SaveReleaseNotes(dir, tag, "# "+tag+"\n\nEdited before the cut."); err != nil {
				t.Fatal(err)
			}
		}
		if rec := runStep(t, r, dir, tag, step); rec.State != RunStateSuccess {
			chunk, _ := r.ReadLog(dir, rec.Id, 0)
			t.Fatalf("%s: %s failed: %s", tag, step, chunk.Text)
		}
		facts = mustFacts(t, r, dir)
		if stepState(facts, step) != RunStateSuccess {
			t.Fatalf("%s: %s is read as %q", tag, step, stepState(facts, step))
		}
		if facts.TagExists != (step == "finalize") {
			t.Fatalf("%s: after %s the tag exists: %v", tag, step, facts.TagExists)
		}
	}
	if !facts.NoGithub || facts.GithubError != "" || facts.OnTrunk {
		t.Fatalf("%s: cut, off GitHub, not back yet: %+v", tag, facts)
	}
	if phased {
		if rec := runStep(t, r, dir, tag, "verify"); rec.State != RunStateSuccess {
			t.Fatalf("%s: verify failed", tag)
		}
	}
	if rec := runStep(t, r, dir, tag, "sync-back"); rec.State != RunStateSuccess {
		chunk, _ := r.ReadLog(dir, rec.Id, 0)
		t.Fatalf("%s: sync-back failed: %s", tag, chunk.Text)
	}
	if facts = mustFacts(t, r, dir); !facts.OnTrunk {
		t.Fatalf("%s: back on develop: %+v", tag, facts)
	}
	notes := gitIn(t, dir, "show", "origin/develop:releases/"+tag+".md")
	if !strings.Contains(notes, "Edited before the cut.") {
		t.Fatalf("%s: the edited notes went out: %q", tag, notes)
	}
	if err := r.EndRelease(dir); err != nil {
		t.Fatal(err)
	}
}

func TestNotuliaShapedReleaseEndToEnd(t *testing.T) {
	for _, variant := range []string{"unphased", "phased"} {
		t.Run(variant, func(t *testing.T) {
			r, dir := makeNotuliaFixture(t, variant)
			report := molten.ValidatePipeline(dir)
			if !report.Valid {
				t.Fatalf("the fixture's pipeline: %v", report.Errors)
			}
			cutRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1", variant == "phased")
			// The next release starts again from develop, which holds the candidate's release commit.
			time.Sleep(1100 * time.Millisecond)
			cutRelease(t, r, dir, ReleaseChannelPublic, "v1.0.0", variant == "phased")
			tags := gitIn(t, dir, "ls-remote", "--tags", "--refs", "origin")
			if !strings.Contains(tags, "refs/tags/v1.0.0-1") || !strings.Contains(tags, "refs/tags/v1.0.0\n") && !strings.HasSuffix(tags, "refs/tags/v1.0.0") {
				t.Fatalf("both tags on origin: %s", tags)
			}
		})
	}
}

func TestADeclaredStepNamedPrepareRunsAsItself(t *testing.T) {
	r, dir := makeNotuliaFixture(t, "unphased")
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	if rec := runStep(t, r, dir, "v1.0.0-1", "promote"); rec.State != RunStateSuccess {
		t.Fatalf("promote: %+v", rec)
	}
	facts := mustFacts(t, r, dir)
	if _, ok := facts.Steps["prepare"]; ok {
		t.Fatalf("the preparation is not the project's prepare step: %+v", facts.Steps)
	}
	rec := runStep(t, r, dir, "v1.0.0-1", "prepare")
	if rec.StepId != "prepare" || !strings.Contains(rec.Command, "pipeline-step.sh prepare 1.0.0 --internal") {
		t.Fatalf("the declared step ran: %+v", rec)
	}
	again := runStep(t, r, dir, "v1.0.0-1", ReleasePreparationStepId)
	if again.StepId != ReleasePreparationStepId || !strings.Contains(again.Command, "warm-cache") {
		t.Fatalf("the preparation again: %+v", again)
	}
	facts = mustFacts(t, r, dir)
	if facts.Steps["prepare"].RunId != rec.Id || facts.Preparation.RunId != again.Id {
		t.Fatalf("each read apart: %+v %+v", facts.Steps, facts.Preparation)
	}
}

func TestAFailedCutIsNotReadAsTagged(t *testing.T) {
	r, dir := makeNotuliaFixture(t, "phased")
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	runStep(t, r, dir, "v1.0.0-1", "prepare")
	os.WriteFile(filepath.Join(dir, ".fail-finalize"), nil, 0644)
	if rec := runFailingStep(t, r, dir, "v1.0.0-1", "finalize"); rec.State != RunStateFailure {
		t.Fatalf("finalize must fail: %+v", rec)
	}
	facts := mustFacts(t, r, dir)
	if facts.TagExists || stepState(facts, "finalize") != RunStateFailure {
		t.Fatalf("a failed cut: %+v", facts)
	}
	// A tag made but not pushed is not a cut.
	gitIn(t, dir, "tag", "v1.0.0-1")
	if facts = mustFacts(t, r, dir); facts.TagExists {
		t.Fatal("a local tag is not on origin")
	}
	gitIn(t, dir, "tag", "-d", "v1.0.0-1")
	if rec := runStep(t, r, dir, "v1.0.0-1", "finalize"); rec.State != RunStateSuccess {
		t.Fatalf("the retry: %+v", rec)
	}
	if facts = mustFacts(t, r, dir); !facts.TagExists {
		t.Fatal("pushed: the cut is done")
	}
}

func TestAnAbandonedReleaseStartsAgainFromScratch(t *testing.T) {
	r, dir := makeNotuliaFixture(t, "unphased")
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	runStep(t, r, dir, "v1.0.0-1", "promote")
	if err := r.StopFollowing(dir, "v1.0.0-1"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	start = startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	facts := mustFacts(t, r, dir)
	if len(facts.Steps) != 0 || facts.Preparation == nil || facts.Preparation.RunId != start.Run.Id {
		t.Fatalf("the abandoned attempt is not read: %+v %+v", facts.Steps, facts.Preparation)
	}
}

func TestOldNotesInAnotherWorktreeAreNotOffered(t *testing.T) {
	r, dir := makeNotuliaFixture(t, "unphased")
	worktree := filepath.Join(filepath.Dir(dir), "fixture-release")
	gitIn(t, dir, "worktree", "add", "-q", "--detach", worktree, "develop")
	os.MkdirAll(filepath.Join(worktree, "releases"), 0755)
	stale := filepath.Join(worktree, "releases", "v1.0.0-1.md")
	os.WriteFile(stale, []byte("left by an abandoned attempt\n"), 0644)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(stale, old, old)
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	if facts := mustFacts(t, r, dir); facts.Notes != "" {
		t.Fatalf("stale notes offered: %q", facts.Notes)
	}
	os.Chtimes(stale, time.Now(), time.Now())
	if facts := mustFacts(t, r, dir); facts.Notes != stale || !facts.NotesDrafted {
		t.Fatalf("fresh notes: %q %v", facts.Notes, facts.NotesDrafted)
	}
}

func TestAReleaseWithoutPreparationStartsNothing(t *testing.T) {
	r, dir := makeReleaseFixture(t, `{"schema":1,"name":"fixture","release":{
		"rc":[{"id":"cut","title":"Cut","phase":"cut","confirm":"sure?","run":"git tag {tag}"}]}}`)
	res, err := r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.0.0-1"})
	if err == nil && res.Untrusted != nil {
		r.GrantTrust(dir, res.Untrusted.Hash)
		res, err = r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: ReleaseChannelRc, Tag: "v1.0.0-1"})
	}
	if err != nil || res.Session == nil || res.Run != nil {
		t.Fatalf("a session, no run: %+v %v", res, err)
	}
	if _, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.0.0-1", Step: ReleasePreparationStepId}); err == nil {
		t.Fatal("no preparation to run again")
	}
}

func TestTheFollowedReleaseRunsAreNotPruned(t *testing.T) {
	r, dir := makeReleaseFixture(t, releasePipeline)
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.2.0-3")
	waitRun(t, r, dir, start.Run.Id)
	for i := 0; i < maxRunsPerProject+3; i++ {
		at := time.Now().Add(time.Duration(i+1) * time.Second)
		rec := RunRecord{Id: newRunId(at), StartedAt: at.UnixMilli(), Dir: dir, Kind: RunKindStep, StepId: "x", State: RunStateSuccess, Phases: []string{}}
		os.MkdirAll(filepath.Join(r.projectDir(dir), rec.Id), 0700)
		if err := r.writeRecord(rec); err != nil {
			t.Fatal(err)
		}
	}
	r.prune(dir)
	kept := false
	for _, rec := range r.List(dir) {
		kept = kept || rec.Id == start.Run.Id
	}
	if !kept || len(r.List(dir)) != maxRunsPerProject+1 {
		t.Fatalf("the preparation's run is kept, the others pruned: %v, %d runs", kept, len(r.List(dir)))
	}
}

func TestReleaseStepPhaseInference(t *testing.T) {
	steps := func(phases ...string) []molten.PipelineStep {
		var rtn []molten.PipelineStep
		for i, phase := range phases {
			rtn = append(rtn, molten.PipelineStep{Id: string(rune('a' + i)), Phase: phase})
		}
		return rtn
	}
	cases := map[string][]molten.PipelineStep{
		"prepare,,,,":                  steps("", "", "", "", ""),
		"prepare,prepare,cut,cut,back": steps("", "prepare", "cut", "", "back"),
		"cut,cut,back":                 steps("cut", "", "back"),
	}
	for want, list := range cases {
		if got := strings.Join(molten.ReleaseStepPhase(list), ","); got != want {
			t.Errorf("%+v: %q, want %q", list, got, want)
		}
	}
	notes := []molten.PipelineStep{{Id: "rewrite", Notes: true, Phase: "cut"}, {Id: "first"}, {Id: "second"}}
	if got := strings.Join(molten.ReleaseStepPhase(notes), ","); got != ",prepare," {
		t.Errorf("a notes step is in no phase, and is not the first: %q", got)
	}
}

func TestReleaseContractWarnings(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","release":{
		"rc":[{"id":"warm","phase":"prepare","run":"true"},{"id":"cut","phase":"cut","run":"true"},
			{"id":"later","run":"true"},{"id":"back","phase":"back","run":"true"},{"id":"late","phase":"cut","run":"true"}],
		"public":[{"id":"warm","run":"true"},{"id":"prepare","confirm":"sure?","run":"true"}]}}`), 0644)
	report := molten.ValidatePipeline(dir)
	warnings := strings.Join(report.Warnings, "\n")
	for _, want := range []string{
		"release.rc[2] (later): no phase while other steps declare one: it runs in the phase of the step before it (cut)",
		"release.rc[4] (late): declared after back, a step of a later phase: it runs in its phase cut, before that step",
		"release.rc: no step declares confirm",
		"release.public: no step declares its phase: the first one runs when a release starts",
	} {
		if !strings.Contains(warnings, want) {
			t.Errorf("missing warning %q in:\n%s", want, warnings)
		}
	}
	if strings.Contains(warnings, "release.public: no step declares confirm") {
		t.Errorf("public declares one:\n%s", warnings)
	}
	if !report.Valid {
		t.Fatalf("warnings only: %v", report.Errors)
	}
}
