// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestTagPrefixAndNotesFollowThePipeline(t *testing.T) {
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P",
		"versions":{"tagprefix":"release-","notes":"docs/notes/{tag}.md"}}`), 0644)
	os.MkdirAll(filepath.Join(dir, "docs", "notes"), 0755)
	os.WriteFile(filepath.Join(dir, "docs", "notes", "release-1.0.0.md"), []byte("public notes"), 0644)
	os.WriteFile(filepath.Join(dir, "docs", "notes", "release-1.0.0.internal.md"), []byte("internal notes"), 0644)
	commitFile(t, dir, "a.txt", "a\n", "feat(#1): first")
	gitIn(t, dir, "tag", "release-1.0.0")
	gitIn(t, dir, "tag", "release-1.1.0-1")
	gitIn(t, dir, "tag", "v9.9.9")
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tag := range snap.Tags {
		names = append(names, tag.Name)
		if tag.Name == "release-1.0.0" && (tag.Notes != "public notes" || tag.NotesInternal != "internal notes") {
			t.Fatalf("notes from versions.notes: %+v", tag)
		}
	}
	if len(names) != 2 || snap.LastPublic != "release-1.0.0" || snap.TagPrefix != "release-" {
		t.Fatalf("tags with the prefix only, the dash of the prefix is not a candidate: %v last %q prefix %q", names, snap.LastPublic, snap.TagPrefix)
	}
	if !IsPrereleaseTag("release-1.1.0-1", "release-") || IsPrereleaseTag("release-1.1.0", "release-") {
		t.Fatal("a candidate is read after the prefix")
	}
}

func TestLastPublicSkipsUpstreamTagsAndSortsBySemver(t *testing.T) {
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P",
		"versions":{"firstpublic":"1.0.0"}}`), 0644)
	commitFile(t, dir, "a.txt", "a\n", "feat(#1): first")
	gitIn(t, dir, "tag", "v0.14.5")
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastPublic != "" || snap.FirstPublic != "1.0.0" {
		t.Fatalf("Wave's v0.14.5 is not a release of this project: last %q first %q", snap.LastPublic, snap.FirstPublic)
	}
	for _, tag := range []string{"v1.9.0", "v1.10.0", "v1.10.0-3", "v1.11.0-1", "v1.10.01"} {
		gitIn(t, dir, "tag", tag)
	}
	snap, err = CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.LastPublic != "v1.10.0" {
		t.Fatalf("last public: %q", snap.LastPublic)
	}
}

func TestReleaseVersionFollowsTheRules(t *testing.T) {
	p := &molten.Pipeline{Versions: &molten.PipelineVersions{FirstPublic: "1.0.0"}}
	for tag, want := range map[string]string{"v1.0.0-1": "1.0.0 rc", "v1.2.0": "1.2.0 public"} {
		version, isRc, err := releaseVersion(p, tag)
		got := version + " public"
		if isRc {
			got = version + " rc"
		}
		if err != nil || got != want {
			t.Errorf("%s: %q, %v", tag, got, err)
		}
	}
	for _, tag := range []string{"v0.15.0", "v1.0.0-0", " v1.0.0", "v1.0.0-rc.1"} {
		if _, _, err := releaseVersion(p, tag); err == nil {
			t.Errorf("%q must be refused", tag)
		}
	}
}

func TestBranchIsExpandedForEachKind(t *testing.T) {
	if got, _ := expandCommand("deploy {branch} {tag} {version} {other}", CommandVars{Version: "1.2.0", Tag: "v1.2.0", Branch: "develop"}); got != "deploy develop v1.2.0 1.2.0 {other}" {
		t.Fatalf("expand: %q", got)
	}
	if got, _ := expandCommand("x {version}", CommandVars{}); got != "x {version}" {
		t.Fatalf("an empty value leaves its variable: %q", got)
	}
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo built from {branch}","artifact":"out"}`)
	gitIn(t, dir, "checkout", "-q", "-b", "feature/9-x")
	rec := waitRun(t, r, dir, trustAndStart(t, r, dir, "gold").Id)
	chunk, _ := r.ReadLog(dir, rec.Id, 0)
	if !strings.Contains(chunk.Text, "built from develop") {
		t.Fatalf("a build's {branch} is the trunk it builds: %q", chunk.Text)
	}
	c, ciDir := makeCiFixture(t, `{"jobs":[{"name":"say","run":"echo testing {branch}"}]}`)
	gitIn(t, ciDir, "checkout", "-q", "-b", "feature/3-y")
	ci := startCi(t, c, ciDir, CiRunRequest{Branch: "feature/3-y"})
	log, _ := c.ReadLog(ciDir, ci.Id, "say", 0)
	if !strings.Contains(log.Text, "testing feature/3-y") {
		t.Fatalf("a CI job's {branch} is the branch under test: %q", log.Text)
	}
}

func TestAdapterStepsRunThroughTheTrustRule(t *testing.T) {
	r, dir := makeReleaseFixture(t, `{"schema":1,"name":"P","steps":[
		{"id":"verify-updater","title":"Verify the updater","section":"cd","run":"echo verifying on {branch}"}]}`)
	res, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "verify-updater"})
	if err != nil || res.Untrusted == nil {
		t.Fatalf("trust first: %+v %v", res, err)
	}
	r.GrantTrust(dir, res.Untrusted.Hash)
	if _, err := r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "nope"}); err == nil {
		t.Fatal("an undeclared step is refused")
	}
	res, err = r.Start(RunRequest{Dir: dir, Kind: RunKindStep, Id: "verify-updater"})
	if err != nil || res.Run == nil {
		t.Fatalf("start: %+v %v", res, err)
	}
	rec := waitRun(t, r, dir, res.Run.Id)
	chunk, _ := r.ReadLog(dir, rec.Id, 0)
	if rec.State != RunStateSuccess || rec.Kind != RunKindStep || !strings.Contains(chunk.Text, "verifying on develop") {
		t.Fatalf("step: %+v %q", rec, chunk.Text)
	}
}

func TestBuildDeclarationsAreValidated(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","builds":[
		{"id":"gold","kind":"beta","verify":"always","phases":[{"id":"Bad Id"}],"run":"true","artifact":"x"}]}`), 0644)
	report := molten.ValidatePipeline(dir)
	var found []string
	for _, e := range report.Errors {
		switch {
		case strings.Contains(e, "kind must be"):
			found = append(found, "kind")
		case strings.Contains(e, "verify must be"):
			found = append(found, "verify")
		case strings.Contains(e, "phases[0]"):
			found = append(found, "phase")
		}
	}
	if !reflect.DeepEqual(found, []string{"kind", "verify", "phase"}) {
		t.Fatalf("errors: %v", report.Errors)
	}
}
