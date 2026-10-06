// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"testing"
	"time"
)

func TestRunningWorkAcrossProjects(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo '▶ phase: build'; sleep 30","artifact":"out"}`)
	if work := RunningWork(r, nil); len(work) != 0 {
		t.Fatalf("nothing runs: %+v", work)
	}
	rec := trustAndStart(t, r, dir, "gold")
	deadline := time.Now().Add(10 * time.Second)
	var work []WorkItem
	for time.Now().Before(deadline) {
		work = RunningWork(r, nil)
		if len(work) == 1 && work[0].Detail == "build" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(work) != 1 || work[0].Id != rec.Id || work[0].Kind != RunKindBuild || work[0].Dir != dir || work[0].Progress != WorkProgressUnknown {
		t.Fatalf("the build runs: %+v", work)
	}
	if err := r.Cancel(dir, rec.Id); err != nil {
		t.Fatal(err)
	}
	waitRun(t, r, dir, rec.Id)
	if work := RunningWork(r, nil); len(work) != 0 {
		t.Fatalf("stopped work leaves the list: %+v", work)
	}
}

func TestCiWorkMeasuresJobs(t *testing.T) {
	item := ciWork(CiRunRecord{Id: "r", Dir: "/p", Branch: "feature/2-x", Jobs: []CiJobRecord{
		{Name: "a", Status: CiStateSuccess}, {Name: "b", Status: CiStateRunning}, {Name: "c", Status: CiStateQueued}, {Name: "d", Status: CiStateFailure}}})
	if item.Title != "Local CI on feature/2-x" || item.Detail != "b" || item.Progress != 0.5 {
		t.Fatalf("ci work: %+v", item)
	}
}

func TestWithWorkspacesNamesTheLinkedWorkspace(t *testing.T) {
	lookups := 0
	items := WithWorkspaces([]WorkItem{{Id: "a", Dir: "/p"}, {Id: "b", Dir: "/p"}, {Id: "c", Dir: "/other"}, {Id: "d"}},
		func(dir string) string {
			lookups++
			if dir == "/p" {
				return "ws-1"
			}
			return ""
		})
	got := []string{items[0].WorkspaceId, items[1].WorkspaceId, items[2].WorkspaceId, items[3].WorkspaceId}
	want := []string{"ws-1", "ws-1", "", ""}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("item %d: %q, want %q", i, got[i], want[i])
		}
	}
	if lookups != 2 {
		t.Fatalf("a project folder is looked up once: %d lookups", lookups)
	}
}
