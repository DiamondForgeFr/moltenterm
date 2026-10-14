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
	"time"
)

func readFixture(t *testing.T, name string) CatalogueWorkflow {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "cijobs", name))
	if err != nil {
		t.Fatal(err)
	}
	return ParseWorkflow(name, string(data))
}

func jobById(t *testing.T, wf CatalogueWorkflow, id string) CatalogueJob {
	t.Helper()
	for _, job := range wf.Jobs {
		if job.Id == id {
			return job
		}
	}
	t.Fatalf("no job %q in %s", id, wf.File)
	return CatalogueJob{}
}

func TestParseWorkflowScheduleDispatchAndComments(t *testing.T) {
	wf := readFixture(t, "nightly.yml")
	if wf.Error != "" {
		t.Fatalf("error: %s", wf.Error)
	}
	if wf.Name != "Nightly" {
		t.Errorf("name %q", wf.Name)
	}
	wantHeader := "Runs the slow end-to-end suite every night and on demand. It also cleans the caches once a week.\n\ne2e      the browser tests\ncleanup  the caches"
	if wf.Description != wantHeader {
		t.Errorf("header:\n%q\nwant\n%q", wf.Description, wantHeader)
	}
	want := []WorkflowTrigger{
		{Event: "schedule", Crons: []string{"30 2 * * *", "0 6 * * 1"}},
		{Event: "workflow_dispatch", Inputs: []string{"suite", "dry"}},
	}
	if !reflect.DeepEqual(wf.Triggers, want) {
		t.Errorf("triggers %+v", wf.Triggers)
	}
	if len(wf.Jobs) != 3 {
		t.Fatalf("jobs %+v", wf.Jobs)
	}
	build := jobById(t, wf, "build")
	if build.Name != "Build" || build.Line != 26 || build.Description != "Builds the app once for the suites below." {
		t.Errorf("build %+v", build)
	}
	e2e := jobById(t, wf, "e2e")
	if e2e.Description != "The browser tests, against the build." {
		t.Errorf("a comment under the key describes the job: %+v", e2e)
	}
	if !reflect.DeepEqual(e2e.Needs, []string{"build"}) || e2e.If != "github.event_name == 'schedule' || inputs.suite == 'all'" {
		t.Errorf("e2e %+v", e2e)
	}
	cleanup := jobById(t, wf, "cleanup")
	if cleanup.Description != "" || cleanup.If != "always()" || !reflect.DeepEqual(cleanup.Needs, []string{"build", "e2e"}) {
		t.Errorf("cleanup %+v", cleanup)
	}
}

func TestParseWorkflowFiltersAndReusable(t *testing.T) {
	wf := readFixture(t, "paths.yml")
	want := []WorkflowTrigger{
		{Event: "push", Branches: []string{"develop"}, Tags: []string{"v*"}, Paths: []string{"docs/**", "mkdocs.yml"}},
		{Event: "pull_request", BranchesIgnore: []string{"gh-pages"}, Types: []string{"opened", "synchronize", "ready_for_review"}, PathsIgnore: []string{"**/*.png"}},
		{Event: "workflow_run", Workflows: []string{"CI"}, Types: []string{"completed"}},
	}
	if !reflect.DeepEqual(wf.Triggers, want) {
		t.Errorf("triggers %+v", wf.Triggers)
	}
	if wf.Description != "" {
		t.Errorf("no header comment: %q", wf.Description)
	}
	publish := jobById(t, wf, "publish")
	if publish.Uses != "./.github/workflows/publish.yml" || publish.If != "${{ github.ref == 'refs/heads/develop' && github.event_name == 'push' }}" {
		t.Errorf("publish %+v", publish)
	}
}

func TestParseWorkflowListAndScalarOn(t *testing.T) {
	wf := readFixture(t, "list.yml")
	if !reflect.DeepEqual(wf.Triggers, []WorkflowTrigger{{Event: "push"}, {Event: "pull_request"}}) {
		t.Errorf("list %+v", wf.Triggers)
	}
	scalar := ParseWorkflow("s.yml", "on: push\njobs:\n  a:\n    steps: []\n")
	if !reflect.DeepEqual(scalar.Triggers, []WorkflowTrigger{{Event: "push"}}) || len(scalar.Jobs) != 1 {
		t.Errorf("scalar %+v", scalar)
	}
}

func TestParseWorkflowBroken(t *testing.T) {
	wf := readFixture(t, "broken.yml")
	if !strings.HasPrefix(wf.Error, "unreadable YAML") || len(wf.Jobs) != 0 {
		t.Errorf("broken %+v", wf)
	}
}

func TestJobCommentIgnoresTheLastStepsComment(t *testing.T) {
	text := "jobs:\n  a:\n    steps:\n      - run: x\n      # about the step\n  b:\n    steps: []\n"
	wf := ParseWorkflow("c.yml", text)
	if b := jobById(t, wf, "b"); b.Description != "" {
		t.Errorf("a deeper comment is the previous job's: %+v", b)
	}
}

func writeFile(t *testing.T, path string, text string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0755)
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestReadCiCatalogueAndStamp(t *testing.T) {
	dir := t.TempDir()
	if WorkflowsStamp(dir) != "" {
		t.Errorf("no workflows, no stamp")
	}
	data, _ := os.ReadFile(filepath.Join("testdata", "cijobs", "nightly.yml"))
	writeFile(t, filepath.Join(dir, ".github", "workflows", "nightly.yml"), string(data))
	writeFile(t, filepath.Join(dir, ".github", "workflows", "notes.txt"), "not a workflow")
	writeFile(t, filepath.Join(dir, ".molten", "project.json"), `{
    "schema": 1,
    "name": "P",
    "ci": {
        "statuses": "github",
        "jobs": [
            { "name": "lint", "title": "Lint", "lane": "quick", "run": "make lint", "description": "Style and formatting." },
            { "name": "unit", "run": "make test" },
            { "name": "types", "lane": "quick", "run": "make types" }
        ]
    },
    "builds": [{ "id": "gold", "title": "Gold", "verify": "ci", "run": "make gold", "artifact": "out" }]
}`)
	cat, err := ReadCiCatalogue(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Workflows) != 1 || cat.Workflows[0].File != "nightly.yml" || len(cat.Workflows[0].Jobs) != 3 {
		t.Fatalf("workflows %+v", cat.Workflows)
	}
	if cat.Local == nil || cat.Local.Statuses != "github" || !reflect.DeepEqual(cat.Local.VerifyBuilds, []string{"Gold"}) {
		t.Fatalf("local %+v", cat.Local)
	}
	want := []CatalogueLocalJob{
		{Name: "lint", Title: "Lint", Lane: "quick", Order: 1, Line: 7, Description: "Style and formatting.", Run: "make lint"},
		{Name: "unit", Lane: "main", Order: 1, Line: 8, Run: "make test"},
		{Name: "types", Lane: "quick", Order: 2, Line: 9, Run: "make types"},
	}
	if !reflect.DeepEqual(cat.Local.Jobs, want) {
		t.Errorf("local jobs %+v", cat.Local.Jobs)
	}
	stamp := WorkflowsStamp(dir)
	if !strings.HasPrefix(stamp, "nightly.yml:") || strings.Contains(stamp, "notes.txt") {
		t.Errorf("stamp %q", stamp)
	}
	later := time.Now().Add(2 * time.Second)
	os.Chtimes(filepath.Join(dir, ".github", "workflows", "nightly.yml"), later, later)
	if WorkflowsStamp(dir) == stamp {
		t.Errorf("an edited workflow moves the stamp")
	}
}

func TestDescribeJobBuildsTheLineFromTheFiles(t *testing.T) {
	dir := t.TempDir()
	data, _ := os.ReadFile(filepath.Join("testdata", "cijobs", "nightly.yml"))
	writeFile(t, filepath.Join(dir, ".github", "workflows", "nightly.yml"), string(data))
	writeFile(t, filepath.Join(dir, ".molten", "project.json"), `{"schema":1,"name":"P","ci":{"jobs":[{"name":"unit","run":"make test"}]}}`)
	var typed []string
	UseAgentLine(func(ctx context.Context, blockId string, line string) JobDescribeResult {
		typed = append(typed, blockId+": "+line)
		return JobDescribeResult{Sent: true, Submitted: true, Message: "Sent."}
	})
	defer UseAgentLine(nil)
	out, err := DescribeJob(context.Background(), JobDescribeRequest{Dir: dir, BlockId: "b1", Kind: JobKindWorkflow, File: "nightly.yml", Job: "cleanup"})
	if err != nil || !out.Sent {
		t.Fatalf("describe: %+v %v", out, err)
	}
	if _, err := DescribeJob(context.Background(), JobDescribeRequest{Dir: dir, BlockId: "b1", Kind: JobKindLocal, Job: "unit"}); err != nil {
		t.Fatal(err)
	}
	if _, err := DescribeJob(context.Background(), JobDescribeRequest{Dir: dir, BlockId: "b1", Kind: JobKindWorkflow, File: "nightly.yml", Job: "gone"}); err == nil {
		t.Errorf("a job no longer in the files is refused")
	}
	if _, err := DescribeJob(context.Background(), JobDescribeRequest{Dir: dir, Kind: JobKindLocal, Job: "unit"}); err == nil {
		t.Errorf("no agent chosen is refused")
	}
	if len(typed) != 2 {
		t.Fatalf("typed %q", typed)
	}
	if !strings.Contains(typed[0], `the job "cleanup" in .github/workflows/nightly.yml (line 42)`) {
		t.Errorf("workflow line %q", typed[0])
	}
	if !strings.Contains(typed[1], `local CI job "unit" in .molten/project.json (line 1)`) {
		t.Errorf("local line %q", typed[1])
	}
}
