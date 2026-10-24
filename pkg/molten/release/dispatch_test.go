// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDispatchFollowsTheRunAndItsApproval(t *testing.T) {
	f := makeFixture(t)
	f.gh.dispatch = func() {
		f.gh.rehearsals = "[" + rehearsalRun(77, "queued", "", "abc", time.Now()) + "]"
	}
	f.gh.views = []string{"waiting ", "waiting ", "in_progress ", "completed success"}
	pending := `[{"environment":{"name":"github-pages"}}]`
	f.gh.pendings = []string{pending, pending}
	e := f.env()
	mustRun(t, f, "dispatch", e.Dispatch(context.Background(), DispatchOptions{Workflow: "deploy-docs.yml", Ref: "v1.0.0", Fields: []string{"site=docs"}}))
	started := f.gh.called("workflow", "run", "deploy-docs.yml")
	if len(started) != 1 || !strings.Contains(strings.Join(started[0], " "), "--ref v1.0.0 -f site=docs") {
		t.Fatalf("dispatch: %v", started)
	}
	out := f.out.String()
	if strings.Count(out, ApprovalMarker+"github-pages https://ci/run/77") != 1 {
		t.Fatalf("the approval is said once:\n%s", out)
	}
	if !strings.Contains(out, ApprovedMarker+"github-pages") || !strings.Contains(out, "deploy-docs.yml is green") {
		t.Fatalf("output:\n%s", out)
	}
}

func TestTheCutMayCommitTheDeclaredChangelogs(t *testing.T) {
	p := &Project{Notes: DefaultNotesPath, Changelogs: []string{"docs/changelog.md", "docs/fr/changelog.md"}}
	allowed := p.releaseFiles("v1.0.0")
	if !allowed["docs/changelog.md"] || !allowed["docs/fr/changelog.md"] || allowed["README.md"] {
		t.Fatalf("%v", allowed)
	}
}

func TestDispatchFailsWithItsRun(t *testing.T) {
	f := makeFixture(t)
	f.gh.dispatch = func() {
		f.gh.rehearsals = "[" + rehearsalRun(78, "queued", "", "abc", time.Now()) + "]"
	}
	f.gh.views = []string{"completed failure"}
	err := f.env().Dispatch(context.Background(), DispatchOptions{Workflow: "deploy.yml"})
	if err == nil || !strings.Contains(err.Error(), "deploy.yml ended failure: https://ci/run/78") {
		t.Fatalf("%v", err)
	}
	if started := f.gh.called("workflow", "run", "deploy.yml"); len(started) != 1 || !strings.Contains(strings.Join(started[0], " "), "--ref develop") {
		t.Fatalf("the trunk by default: %v", started)
	}
	if err := f.env().Dispatch(context.Background(), DispatchOptions{Workflow: "deploy.yml", Fields: []string{"novalue"}}); err == nil {
		t.Fatal("a field is key=value")
	}
}
