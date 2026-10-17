// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const branchCiDevelopRuns = `[
 {"databaseId":30,"workflowName":"CI","event":"push","status":"in_progress","conclusion":"","headBranch":"develop","headSha":"abc1234def","createdAt":"2026-10-16T10:00:00Z","updatedAt":"2026-10-16T10:05:00Z","startedAt":"2026-10-16T10:00:00Z","url":"https://github.com/o/r/actions/runs/30","attempt":1},
 {"databaseId":29,"workflowName":"Nightly","event":"schedule","status":"completed","conclusion":"success","headBranch":"develop","headSha":"abc1234def","createdAt":"2026-10-16T03:00:00Z","updatedAt":"2026-10-16T03:10:00Z","startedAt":"2026-10-16T03:00:00Z","url":"u","attempt":1},
 {"databaseId":28,"workflowName":"CI","event":"pull_request","status":"completed","conclusion":"failure","headBranch":"develop","headSha":"aaa","createdAt":"2026-10-16T09:59:00Z","updatedAt":"2026-10-16T10:10:00Z","startedAt":"2026-10-16T09:59:00Z","url":"u","attempt":1},
 {"databaseId":27,"workflowName":"CI","event":"push","status":"completed","conclusion":"success","headBranch":"develop","headSha":"bbb","createdAt":"2026-10-15T10:00:00Z","updatedAt":"2026-10-15T10:08:00Z","startedAt":"2026-10-15T10:00:00Z","url":"u","attempt":1},
 {"databaseId":26,"workflowName":"CI","event":"push","status":"completed","conclusion":"failure","headBranch":"develop","headSha":"ccc","createdAt":"2026-10-14T10:00:00Z","updatedAt":"2026-10-14T10:30:00Z","startedAt":"2026-10-14T10:00:00Z","url":"u","attempt":1},
 {"databaseId":25,"workflowName":"CI","event":"push","status":"completed","conclusion":"success","headBranch":"develop","headSha":"ddd","createdAt":"2026-10-13T10:00:00Z","updatedAt":"2026-10-13T10:10:00Z","startedAt":"2026-10-13T10:00:00Z","url":"u","attempt":1}
]`

const branchCiMainRuns = `[
 {"databaseId":40,"workflowName":"CI","event":"push","status":"completed","conclusion":"failure","headBranch":"main","headSha":"eee","createdAt":"2026-10-16T08:00:00Z","updatedAt":"2026-10-16T08:09:00Z","startedAt":"2026-10-16T08:00:00Z","url":"https://github.com/o/r/actions/runs/40","attempt":2}
]`

const branchCiJobs30 = `{"jobs":[
 {"name":"Perf budgets","status":"in_progress","conclusion":"","startedAt":"2026-10-16T10:01:00Z","completedAt":"0001-01-01T00:00:00Z","url":"https://github.com/o/r/actions/runs/30/job/301","steps":[]},
 {"name":"Lint","status":"completed","conclusion":"success","startedAt":"2026-10-16T10:00:00Z","completedAt":"2026-10-16T10:02:00Z","url":"https://github.com/o/r/actions/runs/30/job/302","steps":[]}
]}`

const branchCiJobs27 = `{"jobs":[{"name":"Perf budgets","status":"completed","conclusion":"success","startedAt":"2026-10-15T10:00:00Z","completedAt":"2026-10-15T10:08:00Z","url":"u","steps":[]}]}`
const branchCiJobs25 = `{"jobs":[{"name":"Perf budgets","status":"completed","conclusion":"success","startedAt":"2026-10-13T10:00:00Z","completedAt":"2026-10-13T10:06:00Z","url":"u","steps":[]}]}`
const branchCiJobs40 = `{"jobs":[{"name":"Backend tests","status":"completed","conclusion":"failure","startedAt":"2026-10-16T08:00:00Z","completedAt":"2026-10-16T08:09:00Z","url":"https://github.com/o/r/actions/runs/40/job/401","steps":[{"name":"Set up","status":"completed","conclusion":"success"},{"name":"go test","status":"completed","conclusion":"failure"}]}]}`

type branchCiGh struct {
	lock  sync.Mutex
	views map[string]int
}

func (g *branchCiGh) viewed(id string) int {
	g.lock.Lock()
	defer g.lock.Unlock()
	return g.views[id]
}

func (g *branchCiGh) runner() Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "run list --branch develop"):
			return []byte(branchCiDevelopRuns), nil
		case strings.HasPrefix(joined, "run list --branch main"):
			return []byte(branchCiMainRuns), nil
		case strings.HasPrefix(joined, "run view "):
			id := args[2]
			g.lock.Lock()
			g.views[id]++
			g.lock.Unlock()
			return []byte(map[string]string{"30": branchCiJobs30, "27": branchCiJobs27, "25": branchCiJobs25, "40": branchCiJobs40}[id]), nil
		}
		return []byte("{}"), nil
	}
}

func branchCiFixture(t *testing.T) (string, *BranchCi, *branchCiGh) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".github", "workflows"), 0o755)
	os.WriteFile(filepath.Join(dir, ".github", "workflows", "ci.yml"), []byte("name: CI\non: push\n"), 0o644)
	gh := &branchCiGh{views: map[string]int{}}
	collector := MakeCollector(t.TempDir(), gh.runner(), nil)
	collector.lock.Lock()
	state := collector.stateLocked(dir)
	state.snap.Github = &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r"}
	state.snap.Dir = dir
	collector.lock.Unlock()
	return dir, MakeBranchCi(collector, nil, gh.runner()), gh
}

func TestBranchCiLatestRunPerWorkflow(t *testing.T) {
	dir, b, gh := branchCiFixture(t)
	answer, err := b.Get(BranchCiRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Branches) != 2 || answer.Branches[0].Branch != "develop" || answer.Branches[1].Branch != "main" {
		t.Fatalf("branches: %+v", answer.Branches)
	}
	develop := answer.Branches[0]
	if len(develop.Runs) != 1 || develop.Runs[0].DatabaseId != 30 {
		t.Fatalf("develop runs (the push CI only, no schedule or PR run): %+v", develop.Runs)
	}
	run := develop.Runs[0]
	if run.UsualMs != 9*60*1000 {
		t.Fatalf("usual run duration, median of the green runs 8 and 10 min: %d", run.UsualMs)
	}
	if run.Ci.State != ReviewCheckPending || len(run.Jobs) != 2 {
		t.Fatalf("fold: %+v %+v", run.Ci, run.Jobs)
	}
	var perf BranchCiJob
	for _, job := range run.Jobs {
		if job.Name == "Perf budgets" {
			perf = job
		}
	}
	if perf.State != ReviewCheckPending || perf.Status != "in_progress" || perf.UsualMs != 7*60*1000 {
		t.Fatalf("running job with its usual duration (median of 8 and 6 min): %+v", perf)
	}
	main := answer.Branches[1]
	if len(main.Runs) != 1 || main.Runs[0].Ci.State != ReviewCheckFailure {
		t.Fatalf("main: %+v", main.Runs)
	}
	failed := main.Runs[0].Jobs[0]
	if failed.State != ReviewCheckFailure || len(failed.FailedSteps) != 1 || failed.FailedSteps[0] != "go test" {
		t.Fatalf("failed steps: %+v", failed)
	}
	if _, err := b.Get(BranchCiRequest{Dir: dir}); err != nil {
		t.Fatal(err)
	}
	if gh.viewed("27") != 1 || gh.viewed("40") != 1 {
		t.Fatalf("completed runs' jobs are read once: 27=%d 40=%d", gh.viewed("27"), gh.viewed("40"))
	}
	if gh.viewed("30") != 2 {
		t.Fatalf("a running run's jobs are read each time: %d", gh.viewed("30"))
	}
}

func TestBranchCiSameTrunkAndRelease(t *testing.T) {
	dir, b, _ := branchCiFixture(t)
	os.MkdirAll(filepath.Join(dir, ".molten"), 0o755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"x","branches":{"trunk":"main","release":"main"}}`), 0o644)
	answer, _ := b.Get(BranchCiRequest{Dir: dir})
	if len(answer.Branches) != 1 || answer.Branches[0].Branch != "main" || len(answer.Branches[0].Roles) != 2 {
		t.Fatalf("one branch, both roles: %+v", answer.Branches)
	}
}

func TestAwaitedCiOf(t *testing.T) {
	waiting := "▶ promote\nGitHub CI on develop abc1234:\n  ci.yml: no run on this commit, started it.\n  waiting for ci.yml…\n  waiting for ci.yml…\n"
	awaits := awaitedCiOf([]byte(waiting))
	if awaits == nil || awaits.Branch != "develop" || awaits.Sha != "abc1234" || len(awaits.Workflows) != 1 || awaits.Workflows[0] != "ci.yml" {
		t.Fatalf("waiting: %+v", awaits)
	}
	if got := awaitedCiOf([]byte(waiting + "  ci.yml: green\n")); got != nil {
		t.Fatalf("green is no longer awaited: %+v", got)
	}
	if got := awaitedCiOf([]byte(waiting + "Pushing main…\n")); got != nil {
		t.Fatalf("past the CI: %+v", got)
	}
	if got := awaitedCiOf([]byte("nothing to promote.\n")); got != nil {
		t.Fatalf("no header: %+v", got)
	}
}

func TestBranchCiMarksTheAwaitedRun(t *testing.T) {
	dir, b, _ := branchCiFixture(t)
	awaits := &ReleaseCiAwait{Tag: "v1.0.0-4", Branch: "develop", Sha: "abc1234", Workflows: []string{"ci.yml"}}
	branch := b.readBranch(context.Background(), dir, "o/r", BranchCiBranch{Branch: "develop", Roles: []string{BranchCiRoleTrunk}}, awaits, workflowNames(dir, awaits.Workflows))
	if len(branch.Runs) != 1 || branch.Runs[0].AwaitedBy != "v1.0.0-4" {
		t.Fatalf("the develop CI run on the promoted commit is awaited: %+v", branch.Runs)
	}
	other := b.readBranch(context.Background(), dir, "o/r", BranchCiBranch{Branch: "main"}, awaits, workflowNames(dir, awaits.Workflows))
	if other.Runs[0].AwaitedBy != "" {
		t.Fatalf("main is not awaited: %+v", other.Runs)
	}
}
