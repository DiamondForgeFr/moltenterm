// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const releaseFactsPipeline = `{"schema":1,"name":"fixture","versions":{"notes":"releases/{tag}.md"},"release":{
	"rc":[
		{"id":"warm","title":"Warm","phase":"prepare","run":"echo warm"},
		{"id":"draft","title":"Prepare the cut","phase":"cut","run":"mkdir -p out && echo 'notes for {tag}' > out/{tag}.md && echo '▶ notes: out/{tag}.md' && echo drafted"},
		{"id":"rewrite","title":"Rewrite the notes","phase":"cut","notes":true,"run":"echo rewritten > out/{tag}.md"},
		{"id":"cut","title":"Cut","phase":"cut","confirm":"The tag is public once pushed.","run":"git tag {tag}"}],
	"public":[{"id":"cut","title":"Cut","phase":"cut","run":"git tag {tag}"}]}}`

// No gh in tests: GitHub facts are read only through it.
func withoutGh(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name == "gh" {
		return nil, errors.New("gh: not in tests")
	}
	return plainRunner(ctx, dir, name, args...)
}

func runStep(t *testing.T, r *Runs, dir string, tag string, step string) RunRecord {
	t.Helper()
	res, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: tag, Step: step})
	if err != nil || res.Run == nil {
		t.Fatalf("step %s: %+v %v", step, res, err)
	}
	return waitRun(t, r, dir, res.Run.Id)
}

func TestReleaseFactsFollowTheStepsTheNotesAndTheTag(t *testing.T) {
	r, dir := makeReleaseFixture(t, releaseFactsPipeline)
	r.git = withoutGh
	if facts, err := r.ReleaseFactsOf(dir); err != nil || facts.Tag != "" {
		t.Fatalf("nothing followed: %+v %v", facts, err)
	}
	start := startRelease(t, r, dir, ReleaseChannelRc, "v1.0.0-1")
	waitRun(t, r, dir, start.Run.Id)
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil || facts.Session == nil || facts.Tag != "v1.0.0-1" || facts.TagExists || facts.Steps["prepare"].State != RunStateSuccess {
		t.Fatalf("after the preparation: %+v %v", facts, err)
	}
	if facts.Notes != "" {
		t.Fatalf("no notes drafted yet: %q", facts.Notes)
	}
	if _, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v9.9.9-1", Step: "draft"}); err == nil {
		t.Fatal("a step of another release must be refused")
	}
	if _, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.0.0-1", Step: "nope"}); err == nil {
		t.Fatal("an undeclared step must be refused")
	}
	runStep(t, r, dir, "v1.0.0-1", "draft")
	facts, _ = r.ReleaseFactsOf(dir)
	draft := facts.Steps["draft"]
	if facts.Notes != filepath.Join(dir, "out", "v1.0.0-1.md") || strings.Join(draft.Tail, "|") != "drafted" {
		t.Fatalf("notes announced: %q tail %v", facts.Notes, draft.Tail)
	}
	notes, err := r.ReadReleaseNotes(dir, "v1.0.0-1")
	if err != nil || notes.Text != "notes for v1.0.0-1\n" {
		t.Fatalf("notes: %+v %v", notes, err)
	}
	if err := r.SaveReleaseNotes(dir, "v1.0.0-1", "edited"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(facts.Notes); string(data) != "edited\n" {
		t.Fatalf("saved: %q", data)
	}
	runStep(t, r, dir, "v1.0.0-1", "rewrite")
	if data, _ := os.ReadFile(facts.Notes); string(data) != "rewritten\n" {
		t.Fatalf("rewritten: %q", data)
	}
	runStep(t, r, dir, "v1.0.0-1", "cut")
	facts, _ = r.ReleaseFactsOf(dir)
	if !facts.TagExists || facts.Notes != "" || facts.GithubError == "" {
		t.Fatalf("after the cut: %+v", facts)
	}
	if !facts.OnTrunk {
		t.Fatalf("the tag is on develop itself: %+v", facts)
	}
	if err := r.EndRelease(dir); err != nil {
		t.Fatal(err)
	}
	// A tag cut lately is followed without a session.
	facts, _ = r.ReleaseFactsOf(dir)
	if facts.Session != nil || facts.Tag != "v1.0.0-1" || facts.Channel != ReleaseChannelRc {
		t.Fatalf("followed from the tag: %+v", facts)
	}
}

func TestReleaseCarriedBackByACherryPick(t *testing.T) {
	r, dir := makeReleaseFixture(t, releaseFactsPipeline)
	r.git = withoutGh
	gitIn(t, dir, "checkout", "-q", "-b", "main")
	os.WriteFile(filepath.Join(dir, "version.txt"), []byte("1.0.0\n"), 0644)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "chore(release): v1.0.0")
	gitIn(t, dir, "tag", "v1.0.0")
	gitIn(t, dir, "checkout", "-q", "develop")
	facts, _ := r.ReleaseFactsOf(dir)
	if facts.Tag != "v1.0.0" || facts.Channel != ReleaseChannelPublic || facts.OnTrunk {
		t.Fatalf("not back yet: %+v", facts)
	}
	gitIn(t, dir, "cherry-pick", "v1.0.0")
	if facts, _ = r.ReleaseFactsOf(dir); !facts.OnTrunk {
		t.Fatalf("carried back: %+v", facts)
	}
}

func TestOldTagIsNotFollowed(t *testing.T) {
	r, dir := makeReleaseFixture(t, releaseFactsPipeline)
	r.git = withoutGh
	gitIn(t, dir, "tag", "v0.9.0")
	r.now = func() time.Time { return time.Now().Add(4 * 24 * time.Hour) }
	if facts, _ := r.ReleaseFactsOf(dir); facts.Tag != "" {
		t.Fatalf("an old tag is not followed: %+v", facts)
	}
}
