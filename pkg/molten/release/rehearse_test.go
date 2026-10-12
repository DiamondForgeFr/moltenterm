// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const rehearsalArtifacts = `{"artifacts":[
    {"name":"app-rehearsal-macos-abc","size_in_bytes":524288000,"expired":false,"expires_at":"2026-10-26T10:00:00Z"},
    {"name":"app-rehearsal-old","size_in_bytes":1000,"expired":true,"expires_at":"2026-10-01T10:00:00Z"}
]}`

func rehearsalRun(id int, status string, conclusion string, sha string, created time.Time) string {
	return fmt.Sprintf(`{"databaseId":%d,"status":%q,"conclusion":%q,"url":"https://ci/run/%d","createdAt":%q,"headSha":%q}`,
		id, status, conclusion, id, created.UTC().Format(time.RFC3339), sha)
}

func TestRehearseDispatchesWaitsAndDownloads(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	sha := f.originRef(t, "develop")
	f.gh.dispatch = func() {
		f.gh.rehearsals = "[" + rehearsalRun(77, "queued", "", sha, time.Now()) + "]"
	}
	f.gh.views = []string{"in_progress ", "completed success"}
	f.gh.artifacts = rehearsalArtifacts
	downloads := filepath.Join(f.base, "downloads")
	stale := filepath.Join(downloads, sha[:7], "stale.txt")
	writeFile(t, stale, "left by an earlier run\n")

	e := f.env()
	mustRun(t, f, "rehearse", e.Rehearse(ctx, RehearseOptions{Workflow: "release.yml", Download: downloads}))

	dispatched := f.gh.called("workflow", "run", "release.yml")
	if len(dispatched) != 1 || !strings.Contains(strings.Join(dispatched[0], " "), "--ref develop") {
		t.Fatalf("want one dispatch on develop, got %v", dispatched)
	}
	listed := f.gh.called("run", "list", "--workflow", "release.yml")
	if len(listed) == 0 || !strings.Contains(strings.Join(listed[0], " "), "--commit "+sha) {
		t.Fatalf("the runs were not looked up on the trunk's commit: %v", listed)
	}
	download := f.gh.called("run", "download", "77")
	if len(download) != 1 || !strings.Contains(strings.Join(download[0], " "), filepath.Join(downloads, sha[:7])) {
		t.Fatalf("want the artifacts downloaded into <dir>/<short sha>, got %v", download)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("the folder of an earlier download was not emptied")
	}
	out := f.out.String()
	for _, want := range []string{"no tag, no release", "https://ci/run/77", "app-rehearsal-macos-abc (500 MB, until 2026-10-26)", "▶ phase: build", "Downloaded into"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "app-rehearsal-old") {
		t.Fatalf("an expired artifact was listed:\n%s", out)
	}
	if len(f.gh.called("release")) != 0 {
		t.Fatalf("a rehearsal touched a GitHub release")
	}
	if tags := gitIn(t, f.origin, "tag", "--list"); tags != "" {
		t.Fatalf("a rehearsal pushed tags: %s", tags)
	}
}

func TestRehearseFollowsTheRunAlreadyGoing(t *testing.T) {
	f := makeFixture(t)
	sha := f.originRef(t, "develop")
	f.gh.rehearsals = "[" + rehearsalRun(5, "in_progress", "", sha, time.Now().Add(-10*time.Minute)) + "]"
	f.gh.views = []string{"completed success"}
	f.gh.artifacts = rehearsalArtifacts
	mustRun(t, f, "rehearse", f.env().Rehearse(context.Background(), RehearseOptions{Workflow: "release.yml"}))
	if len(f.gh.called("workflow", "run")) != 0 {
		t.Fatalf("a second rehearsal of the same commit was started")
	}
	if !strings.Contains(f.out.String(), "gh run download 5") {
		t.Fatalf("without --download, the output must say how to download:\n%s", f.out.String())
	}
}

func TestRehearseReusesAGreenRunWithArtifacts(t *testing.T) {
	f := makeFixture(t)
	sha := f.originRef(t, "develop")
	f.gh.rehearsals = "[" + rehearsalRun(4, "completed", "failure", sha, time.Now().Add(-time.Hour)) + "," +
		rehearsalRun(3, "completed", "success", sha, time.Now().Add(-2*time.Hour)) + "]"
	f.gh.artifacts = rehearsalArtifacts
	mustRun(t, f, "rehearse", f.env().Rehearse(context.Background(), RehearseOptions{Workflow: "release.yml"}))
	if len(f.gh.called("workflow", "run")) != 0 || !strings.Contains(f.out.String(), "already rehearsed: https://ci/run/3") {
		t.Fatalf("the green rehearsal was not reused:\n%s", f.out.String())
	}

	// Inputs are not listed by GitHub: a run asked with inputs is always a new one.
	f.gh.dispatch = func() {
		f.gh.rehearsals = "[" + rehearsalRun(9, "completed", "success", sha, time.Now()) + "]"
	}
	mustRun(t, f, "rehearse --field", f.env().Rehearse(context.Background(), RehearseOptions{Workflow: "release.yml", Fields: []string{"channel=public"}}))
	dispatched := f.gh.called("workflow", "run")
	if len(dispatched) != 1 || !strings.Contains(strings.Join(dispatched[0], " "), "-f channel=public") {
		t.Fatalf("want one dispatch with the input, got %v", dispatched)
	}
}

func TestRehearseFailsOnARedRun(t *testing.T) {
	f := makeFixture(t)
	sha := f.originRef(t, "develop")
	f.gh.dispatch = func() {
		f.gh.rehearsals = "[" + rehearsalRun(8, "queued", "", sha, time.Now()) + "]"
	}
	f.gh.views = []string{"completed failure"}
	err := f.env().Rehearse(context.Background(), RehearseOptions{Workflow: "release.yml", Download: filepath.Join(f.base, "d")})
	mustFail(t, f, "rehearse", err, "ended failure: https://ci/run/8")
	if len(f.gh.called("run", "download")) != 0 {
		t.Fatalf("a red rehearsal was downloaded")
	}
}

func TestRehearseRefusals(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	mustFail(t, f, "no workflow", f.env().Rehearse(ctx, RehearseOptions{}), "--workflow")
	mustFail(t, f, "bad field", f.env().Rehearse(ctx, RehearseOptions{Workflow: "release.yml", Fields: []string{"channel"}}), "not key=value")
	mustFail(t, f, "unknown branch", f.env().Rehearse(ctx, RehearseOptions{Workflow: "release.yml", Ref: "nowhere"}), "no branch nowhere")
	f.github = false
	mustFail(t, f, "off GitHub", f.env().Rehearse(ctx, RehearseOptions{Workflow: "release.yml"}), "not on GitHub")
	if len(f.gh.called("workflow", "run")) != 0 {
		t.Fatalf("a refused rehearsal started a workflow")
	}
}

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	if got := expandHome("~/Downloads/x"); got != filepath.Join(home, "Downloads", "x") {
		t.Fatalf("expandHome: %s", got)
	}
	if got := expandHome("/abs/~x"); got != "/abs/~x" {
		t.Fatalf("expandHome changed an absolute path: %s", got)
	}
}
