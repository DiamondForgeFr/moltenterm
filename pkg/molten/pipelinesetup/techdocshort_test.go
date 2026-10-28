// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #1226: the technical documentation is one short source. The input is the pipeline SaaSFoundryAI's reviewer saw in
// its PR #1116, where the generated document came to 196 lines that copied project.json.

const sf1116PrUrl = "https://github.com/DiamondForgeFr/SaasFoundryAI/pull/1116"

func sf1116DocInput(t *testing.T) TechDocInput {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "techdoc-1116-project.json"))
	if err != nil {
		t.Fatal(err)
	}
	var p molten.Pipeline
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	in := saasFoundryDocInput(t)
	in.Pipeline = &p
	in.Facts = DetectWith(saasFoundryFixture(t), molten.PipelineReport{Present: true, Valid: true, Pipeline: &p})
	in.Facts.Branches.Trunk, in.Facts.Branches.Release = "develop", "master"
	in.Facts.Protection = &Protection{Branch: "master", Read: true, PullRequest: true, RequiredChecks: []string{"CI / Required gate"},
		MergeMethods: []string{"merge"}, Bypass: BypassNever, Sources: []Source{{Code: "ruleset", Path: "master", Detail: "7"}}}
	in.Change.PrUrl = sf1116PrUrl
	return in
}

func TestTechDocOfPR1116IsShort(t *testing.T) {
	in := sf1116DocInput(t)
	doc := BuildTechDoc(in)
	if BuildTechDoc(in) != doc {
		t.Fatal("the same pipeline gives another document")
	}
	if lines := strings.Count(doc, "\n"); lines > 80 {
		t.Fatalf("%d lines, 80 at most:\n%s", lines, doc)
	}

	for _, want := range []string{
		"# Release pipeline: SaaSFoundryAI",
		"do not edit it by hand",
		"```mermaid\nflowchart LR\n",
		"subgraph rc[\"Release candidate\"]",
		"subgraph public[\"Public release\"]",
		"(by hand)\"/]",
		"-. tag starts .-> public_wf_publish_stable_yml[\"publish-stable.yml · approval: npm-production\"] --> public_to_npm[(\"npm\")]",
		"a release branch made from the trunk reaches the published branch by pull request (`merge`)",
		"- **Tags:** public `vX.Y.Z`, release candidates `vX.Y.Z-N`.",
		"(commands, instructions, CI jobs, version files): `.molten/project.json`.",
		"## Release candidate flow",
		"## Public release flow",
		"| # | Phase | Step | Who | Asks to confirm |",
		"| 1 | prepare | Bump the version and draft the notes on rc-X.Y.Z, made from develop | MoltenTerm | — |",
		"| 3 | cut | Write the {version} section of docs/changelog.md | By hand | — |",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("the document lacks %q:\n%s", want, doc)
		}
	}

	// What project.json, or GitHub, already says is not copied.
	for _, job := range in.Pipeline.Ci.Jobs {
		for _, copied := range []string{job.Run, job.Title} {
			if strings.Contains(doc, copied) {
				t.Fatalf("the CI job %q is copied:\n%s", copied, doc)
			}
		}
	}
	for _, file := range in.Pipeline.Versions.Files {
		if strings.Contains(doc, file.Path) {
			t.Fatalf("the version file %q is listed:\n%s", file.Path, doc)
		}
	}
	for _, steps := range [][]molten.PipelineStep{in.Pipeline.Release.Rc, in.Pipeline.Release.Public} {
		for _, s := range steps {
			if s.Manual != "" && strings.Contains(doc, s.Manual) {
				t.Fatalf("the instructions of %q are copied:\n%s", s.Id, doc)
			}
			if s.Run != "" && strings.Contains(doc, s.Run) {
				t.Fatalf("the command of %q is copied:\n%s", s.Id, doc)
			}
		}
	}
	for _, described := range []string{"workflow_dispatch", "Triggers", "required checks", "ruleset", "Branches and protection", "CI workflows",
		"Approvals", "Sync-back", "Version files", "Local CI", "push of tags"} {
		if strings.Contains(doc, described) {
			t.Fatalf("the document describes %q:\n%s", described, doc)
		}
	}
}

func TestTechDocEveryStepShowsAPhase(t *testing.T) {
	doc := BuildTechDoc(sf1116DocInput(t))
	rows, notes := 0, 0
	for _, line := range strings.Split(doc, "\n") {
		cells := strings.Split(line, " | ")
		if len(cells) < 5 || !strings.HasPrefix(line, "| ") || strings.HasPrefix(line, "| #") || strings.HasPrefix(line, "| ---") || strings.HasPrefix(line, "| Date") {
			continue
		}
		if _, err := strconv.Atoi(strings.TrimPrefix(cells[0], "| ")); err != nil {
			continue
		}
		rows++
		known := false
		for _, phase := range molten.PipelineReleasePhases {
			known = known || cells[1] == phase
		}
		if !known {
			t.Fatalf("no phase on %q", line)
		}
		if strings.Contains(cells[2], "Rewrite the public notes") {
			notes++
			if cells[1] != "cut" {
				t.Fatalf("the notes rewrite is in phase %q, not cut", cells[1])
			}
		}
	}
	if rows != 5+11 || notes != 2 {
		t.Fatalf("%d step rows, %d notes steps:\n%s", rows, notes, doc)
	}

	// A list that declares no phase is read as the release goes.
	steps := []molten.PipelineStep{{Id: "a"}, {Id: "b"}, {Id: "tag"}, {Id: "c"}}
	if got := strings.Join(docPhases(steps), ","); got != "prepare,cut,cut,back" {
		t.Fatalf("phases of an unphased list: %s", got)
	}
}

func TestTechDocHistoryLinksThePullRequest(t *testing.T) {
	in := sf1116DocInput(t)
	if doc := BuildTechDoc(in); !strings.Contains(doc, "| Pipeline set up | Setup test | ["+"#1116]("+sf1116PrUrl+") | 2 |") {
		t.Fatalf("history:\n%s", doc[strings.Index(doc, techDocHistoryStart):])
	}
	in.Change.PrUrl = ""
	if doc := BuildTechDoc(in); !strings.Contains(doc, "pulls?q=") {
		t.Fatalf("before the pull request exists, the row links the branch:\n%s", doc[strings.Index(doc, techDocHistoryStart):])
	}
}

func TestTechDocPathIsOutsideTheDocsSiteAndConfigurable(t *testing.T) {
	if TechDocPath != ".molten/release-pipeline.md" || TechDocPathOf(nil) != TechDocPath || TechDocPathOf(&molten.Pipeline{}) != TechDocPath {
		t.Fatalf("default path: %q", TechDocPath)
	}
	if got := TechDocPathOf(&molten.Pipeline{TechDoc: "./ops/pipeline.md"}); got != "ops/pipeline.md" {
		t.Fatalf("configured path: %q", got)
	}
	dir := t.TempDir()
	for _, bad := range []string{"../out.md", "/etc/x.md", "docs/page.txt", `a\b.md`, ".git/x.md"} {
		report := molten.ValidatePipelineData(dir, []byte(`{"schema":1,"name":"x","techdoc":`+quote(bad)+`}`))
		if report.Valid {
			t.Fatalf("techdoc %q is valid", bad)
		}
	}
	if report := molten.ValidatePipelineData(dir, []byte(`{"schema":1,"name":"x","techdoc":"docs/ops/pipeline.md"}`)); !report.Valid {
		t.Fatalf("a good techdoc: %v", report.Errors)
	}
}

func quote(s string) string {
	data, _ := json.Marshal(s)
	return string(data)
}

// A generated document at the former default path is moved by the pull request, not copied: the old file is removed,
// the new one keeps its history rows, and the row of this change links the pull request.
func TestTechDocMovesFromTheFormerPath(t *testing.T) {
	dir := protectedRepository(t)
	old := "# Release pipeline: old\n\n" + techDocHistoryStart + "\n" + techDocHistoryHead + "\n" + techDocHistoryRule +
		"\n| 2026-09-01 | Pipeline set up | Early dev | — | 1 |\n" + techDocHistoryEnd + "\n"
	writeFiles(t, dir, map[string]string{LegacyTechDocPath: old, "docs/engineering/notes.md": "mine\n"})
	gitIn(t, dir, "add", "docs")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#4): the former doc")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")

	forge := &fakeForge{}
	s := prSetup(t, forge, protectedRules(t))
	ctx := context.Background()
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := s.TechDoc(ctx, TechDocRequest{Dir: dir, Text: draft.Proposed})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Path != TechDocPath || plan.MovedFrom != LegacyTechDocPath || plan.Current != old {
		t.Fatalf("plan: %+v", plan)
	}
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if job.Failure != nil {
		t.Fatalf("failure: %+v", job.Failure)
	}
	gitIn(t, dir, "fetch", "--quiet", "origin")
	status := gitOut(t, dir, "diff", "--name-status", "origin/develop", "origin/"+job.Branch)
	if !strings.Contains(status, "D\t"+LegacyTechDocPath+"\n") || !strings.Contains(status, "A\t"+TechDocPath+"\n") || strings.Contains(status, "notes.md") {
		t.Fatalf("the move:\n%s", status)
	}
	pushed := gitOut(t, dir, "show", "origin/"+job.Branch+":"+TechDocPath)
	if !strings.Contains(pushed, "| 2026-09-01 | Pipeline set up | Early dev |") || !strings.Contains(pushed, "/pull/42)") {
		t.Fatalf("the moved document:\n%s", pushed)
	}
	if count := strings.TrimSpace(gitOut(t, dir, "rev-list", "--count", "origin/develop..origin/"+job.Branch)); count != "1" {
		t.Fatalf("the pull request holds %s commits", count)
	}
}
