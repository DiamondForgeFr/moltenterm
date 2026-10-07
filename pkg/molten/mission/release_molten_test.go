// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
)

// MoltenTerm's own release steps (FR-REL-002), run by Mission Control as the Project tab runs them, against a local
// origin: `molten` on the steps' PATH is this test binary, which runs the release commands (TestMoltenReleaseHelper).

const releaseHelperEnv = "MOLTEN_RELEASE_HELPER"

// TestMoltenReleaseHelper is the `molten` the steps call; it does nothing in a normal test run.
func TestMoltenReleaseHelper(t *testing.T) {
	if os.Getenv(releaseHelperEnv) != "1" {
		t.Skip("the molten command of TestMoltentermReleaseStepsEndToEnd")
	}
	args := os.Args[slices.Index(os.Args, "--")+1:]
	dir, _ := os.Getwd()
	env := &release.Env{Dir: dir, Out: os.Stdout}
	ctx := context.Background()
	var err error
	switch {
	case len(args) == 4 && args[0] == "release" && args[1] == "promote" && args[2] == "--workflow":
		err = env.Promote(ctx, release.PromoteOptions{Workflows: []string{args[3]}})
	case len(args) == 3 && args[0] == "release" && args[1] == "prepare":
		err = env.Prepare(ctx, args[2])
	case len(args) == 3 && args[0] == "release" && args[1] == "finalize":
		err = env.Finalize(ctx, args[2])
	case len(args) == 3 && args[0] == "release" && args[1] == "sync-back":
		err = env.SyncBack(ctx, args[2])
	case len(args) == 3 && args[0] == "release" && args[1] == "close-milestone":
		err = env.CloseMilestone(ctx, args[2])
	default:
		err = fmt.Errorf("unknown command: %s", strings.Join(args, " "))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "molten: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// makeMoltentermFixture makes <tmp>/origin.git and its clone <tmp>/app, whose pipeline declares MoltenTerm's own
// versions and release steps, and a bin folder whose molten is this test binary.
func makeMoltentermFixture(t *testing.T) (*Runs, string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the steps run through /bin/sh")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Release test")
	t.Setenv("GIT_AUTHOR_EMAIL", "release@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Release test")
	t.Setenv("GIT_COMMITTER_EMAIL", "release@example.invalid")
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var own map[string]json.RawMessage
	data, err := os.ReadFile(filepath.Join("..", "..", "..", molten.ProjectPipelineFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &own); err != nil {
		t.Fatal(err)
	}
	pipeline, _ := json.MarshalIndent(map[string]json.RawMessage{
		"schema":   json.RawMessage(`1`),
		"name":     json.RawMessage(`"Fixture"`),
		"versions": own["versions"],
		"release":  own["release"],
	}, "", "    ")

	origin, dir := filepath.Join(base, "origin.git"), filepath.Join(base, "app")
	gitIn(t, base, "init", "--quiet", "--bare", "-b", "develop", origin)
	gitIn(t, base, "init", "--quiet", "-b", "develop", dir)
	gitIn(t, dir, "remote", "add", "origin", origin)
	files := map[string]string{
		molten.ProjectPipelineFile: string(pipeline) + "\n",
		"package.json":             "{\n    \"name\": \"fixture\",\n    \"version\": \"1.0.0-0\"\n}\n",
		"package-lock.json":        "{\n    \"name\": \"fixture\",\n    \"version\": \"1.0.0-0\",\n    \"packages\": {\n        \"\": {\n            \"version\": \"1.0.0-0\"\n        }\n    }\n}\n",
		"app.txt":                  "one\n",
	}
	for name, text := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#1): bootstrap")
	gitIn(t, dir, "push", "--quiet", "-u", "origin", "develop")
	gitIn(t, dir, "push", "--quiet", "origin", "develop:main")

	bin := filepath.Join(base, "bin")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := fmt.Sprintf("#!/bin/sh\n%s=1 exec %s -test.run '^TestMoltenReleaseHelper$' -- \"$@\"\n", releaseHelperEnv, shellQuote(self))
	if err := os.MkdirAll(bin, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "molten"), []byte(shim), 0755); err != nil {
		t.Fatal(err)
	}
	savedLogin, savedBin := readLoginPath, appBinDir
	readLoginPath = func() string { return os.Getenv("PATH") }
	appBinDir = func() string { return bin }
	t.Cleanup(func() { readLoginPath, appBinDir = savedLogin, savedBin })

	runsData := t.TempDir()
	r := MakeRuns(filepath.Join(runsData, "runs"), MakeTrustStore(filepath.Join(runsData, TrustFileName)), nil)
	r.git = offGithub
	return r, dir, origin
}

func mustSucceed(t *testing.T, r *Runs, dir string, what string, rec RunRecord) {
	t.Helper()
	if rec.State != RunStateSuccess {
		chunk, _ := r.ReadLog(dir, rec.Id, 0)
		t.Fatalf("%s failed: %s", what, chunk.Text)
	}
}

func commitOn(t *testing.T, dir string, subject string) {
	t.Helper()
	gitIn(t, dir, "fetch", "--quiet", "origin")
	gitIn(t, dir, "checkout", "--quiet", "-B", "develop", "origin/develop")
	path := filepath.Join(dir, "app.txt")
	data, _ := os.ReadFile(path)
	if err := os.WriteFile(path, append(data, []byte(subject+"\n")...), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "commit", "--quiet", "-am", subject)
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
}

func cutMoltentermRelease(t *testing.T, r *Runs, dir string, origin string, channel string, tag string) {
	t.Helper()
	start := startRelease(t, r, dir, channel, tag)
	mustSucceed(t, r, dir, tag+" preparation", waitRun(t, r, dir, start.Run.Id))
	facts := mustFacts(t, r, dir)
	if got := strings.Join(facts.Preparation.Phases, ","); got != "promote,prepare" {
		t.Fatalf("%s: prepared %q", tag, got)
	}
	if gitIn(t, origin, "rev-parse", "main") == "" {
		t.Fatalf("%s: main is missing", tag)
	}
	notes := filepath.Join(dir+release.ReleaseWorktreeSuffix, "releases", tag+".md")
	if facts.Notes != notes {
		t.Fatalf("%s: the notes Mission Control edits: %q, want %q", tag, facts.Notes, notes)
	}
	text, err := r.ReadReleaseNotes(dir, tag)
	if err != nil || !strings.Contains(text.Text, "A feature for "+tag) {
		t.Fatalf("%s: drafted notes %+v %v", tag, text, err)
	}
	if err := r.SaveReleaseNotes(dir, tag, text.Text+"\nEdited before the cut.\n"); err != nil {
		t.Fatal(err)
	}
	mustSucceed(t, r, dir, tag+" finalize", runStep(t, r, dir, tag, "finalize"))
	if facts = mustFacts(t, r, dir); !facts.TagExists {
		t.Fatalf("%s: the tag is not on origin", tag)
	}
	if channel == ReleaseChannelPublic {
		mustSucceed(t, r, dir, tag+" close-milestone", runStep(t, r, dir, tag, "close-milestone"))
	}
	mustSucceed(t, r, dir, tag+" sync-back", runStep(t, r, dir, tag, "sync-back"))
	// Off GitHub the branch is pushed for a merge there: merged here as its pull request would be.
	gitIn(t, origin, "update-ref", "refs/heads/develop", "refs/heads/"+release.SyncBackBranchPrefix+tag)
	if facts = mustFacts(t, r, dir); !facts.OnTrunk {
		t.Fatalf("%s: not back on develop: %+v", tag, facts)
	}
	if !strings.Contains(gitIn(t, origin, "show", "develop:releases/"+tag+".md"), "Edited before the cut.") {
		t.Fatalf("%s: the edited notes did not go out", tag)
	}
	if err := r.EndRelease(dir); err != nil {
		t.Fatal(err)
	}
}

func TestMoltentermReleaseStepsEndToEnd(t *testing.T) {
	r, dir, origin := makeMoltentermFixture(t)
	if report := molten.ValidatePipeline(dir); !report.Valid || len(report.Warnings) > 0 {
		t.Fatalf("the fixture's pipeline: %v %v", report.Errors, report.Warnings)
	}
	commitOn(t, dir, "feat(#2): a feature for v1.0.0-1")
	cutMoltentermRelease(t, r, dir, origin, ReleaseChannelRc, "v1.0.0-1")
	if got := gitIn(t, origin, "log", "-1", "--format=%s", "v1.0.0-1"); got != "chore(release): v1.0.0-1 (rc)" {
		t.Fatalf("release commit %q", got)
	}
	time.Sleep(1100 * time.Millisecond)
	commitOn(t, dir, "feat(#3): a feature for v1.0.0")
	cutMoltentermRelease(t, r, dir, origin, ReleaseChannelPublic, "v1.0.0")
	if got := gitIn(t, origin, "show", "v1.0.0:package-lock.json"); strings.Count(got, `"1.0.0"`) != 2 {
		t.Fatalf("package-lock.json of v1.0.0:\n%s", got)
	}
}
