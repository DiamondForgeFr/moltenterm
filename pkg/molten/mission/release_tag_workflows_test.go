// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const tagWorkflowsPipeline = `{"schema":1,"name":"fixture","release":{
	"rc":[
		{"id":"warm","title":"Warm","phase":"prepare","run":"echo warm"},
		{"id":"cut","title":"Cut","phase":"cut","run":"git tag {tag}"}],
	"public":[{"id":"cut","title":"Cut","phase":"cut","run":"git tag {tag}"}]}}`

// Only on public tags, as SaaSFoundryAI's publish-stable.yml: a release candidate tag starts nothing.
const publishStableWorkflow = `name: Publish stable
on:
  push:
    tags: ['v[0-9]+.[0-9]+.[0-9]+']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`

const releaseWorkflow = `name: Release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: gh release create "$GITHUB_REF_NAME"
`

// fakeGh answers as a GitHub repository whose tag started no run and has no release, and records what was asked.
type fakeGh struct {
	lock  sync.Mutex
	calls []string
}

func (f *fakeGh) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return plainRunner(ctx, dir, name, args...)
	}
	f.record(strings.Join(args, " "))
	switch {
	case len(args) >= 2 && args[0] == "run" && args[1] == "list", len(args) >= 2 && args[0] == "pr" && args[1] == "list":
		return []byte("[]"), nil
	case len(args) >= 2 && args[0] == "repo" && args[1] == "view":
		return []byte(`{"url":"https://github.com/o/r"}`), nil
	case len(args) >= 2 && args[0] == "workflow" && args[1] == "run":
		return nil, nil
	}
	return nil, errors.New("release not found")
}

func (f *fakeGh) record(call string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeGh) asked(prefix string) []string {
	f.lock.Lock()
	defer f.lock.Unlock()
	var rtn []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			rtn = append(rtn, c)
		}
	}
	return rtn
}

func commitWorkflow(t *testing.T, dir string, name string, text string) {
	t.Helper()
	wfDir := filepath.Join(dir, ".github", "workflows")
	if err := os.MkdirAll(wfDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wfDir, name), []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "workflow "+name)
}

func cutRc(t *testing.T, r *Runs, dir string, tag string) {
	t.Helper()
	start := startRelease(t, r, dir, ReleaseChannelRc, tag)
	waitRun(t, r, dir, start.Run.Id)
	if rec := runStep(t, r, dir, tag, "cut"); rec.State != RunStateSuccess {
		t.Fatalf("the cut: %+v", rec)
	}
}

func TestReleaseCandidateTagThatStartsNoWorkflow(t *testing.T) {
	r, dir := makeReleaseFixture(t, tagWorkflowsPipeline)
	gh := &fakeGh{}
	r.git = gh.run
	commitWorkflow(t, dir, "publish-stable.yml", publishStableWorkflow)
	cutRc(t, r, dir, "v1.0.0-1")
	// A workflow added after the tag is not the tag's: GitHub reads them at the tagged commit.
	commitWorkflow(t, dir, "release.yml", releaseWorkflow)
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil || !facts.TagExists {
		t.Fatalf("facts: %+v %v", facts, err)
	}
	if facts.TagWorkflows == nil || len(facts.TagWorkflows.Workflows) != 0 || facts.TagWorkflows.Overdue {
		t.Fatalf("no workflow starts on the rc tag: %+v", facts.TagWorkflows)
	}
	if err := r.DispatchTagWorkflow(ReleaseDispatchRequest{Dir: dir, Tag: "v1.0.0-1", Workflow: "release.yml"}); err == nil {
		t.Fatal("a workflow the tag does not start must not be dispatched")
	}
	if got := gh.asked("workflow run"); len(got) != 0 {
		t.Fatalf("nothing dispatched: %v", got)
	}
}

func TestTagWorkflowThatNeverStarted(t *testing.T) {
	r, dir := makeReleaseFixture(t, tagWorkflowsPipeline)
	gh := &fakeGh{}
	r.git = gh.run
	r.tagRunGrace = time.Hour
	commitWorkflow(t, dir, "publish-stable.yml", publishStableWorkflow)
	commitWorkflow(t, dir, "release.yml", releaseWorkflow)
	cutRc(t, r, dir, "v1.0.0-1")
	facts, _ := r.ReleaseFactsOf(dir)
	tw := facts.TagWorkflows
	if tw == nil || len(tw.Workflows) != 1 || tw.Workflows[0].File != "release.yml" || !tw.Workflows[0].Dispatch || !tw.Workflows[0].Publishes {
		t.Fatalf("release.yml starts on the tag: %+v", tw)
	}
	if tw.Overdue || tw.Workflows[0].Url != "" {
		t.Fatalf("its run may still start: %+v", tw)
	}
	now := time.Now().Add(2 * time.Hour)
	r.now = func() time.Time { return now }
	facts, _ = r.ReleaseFactsOf(dir)
	tw = facts.TagWorkflows
	if tw == nil || !tw.Overdue || tw.Workflows[0].Url != "https://github.com/o/r/actions/workflows/release.yml" {
		t.Fatalf("overdue, with its page: %+v", tw)
	}
	if err := r.DispatchTagWorkflow(ReleaseDispatchRequest{Dir: dir, Tag: "v1.0.0-1", Workflow: "publish-stable.yml"}); err == nil {
		t.Fatal("only a workflow the tag starts is dispatched")
	}
	if err := r.DispatchTagWorkflow(ReleaseDispatchRequest{Dir: dir, Tag: "v9.9.9-1", Workflow: "release.yml"}); err == nil {
		t.Fatal("only on the release followed")
	}
	if err := r.DispatchTagWorkflow(ReleaseDispatchRequest{Dir: dir, Tag: "v1.0.0-1", Workflow: "release.yml"}); err != nil {
		t.Fatal(err)
	}
	if got := gh.asked("workflow run"); len(got) != 1 || got[0] != "workflow run release.yml --ref v1.0.0-1" {
		t.Fatalf("dispatched on the tag: %v", got)
	}
}
