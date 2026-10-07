// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestDraftNotes(t *testing.T) {
	notes := DraftNotes(NotesFacts{Subjects: []string{
		"feat(#12): show the milestone in the release menu",
		"fix(#13): a crash when the folder is gone (#13)",
		"perf: faster start",
		"chore(#14): bump a dependency",
		"Merge pull request #9 from someone/branch",
		"feat(#15)!: a new settings format",
		"feat(#16): Show the milestone in the release menu",
		"a subject outside the convention",
	}})
	want := "## New\n\n- Show the milestone in the release menu\n- A new settings format\n\n## Fixes\n\n- A crash when the folder is gone\n- Faster start\n"
	if notes != want {
		t.Fatalf("notes:\n%s\nwant:\n%s", notes, want)
	}
	if got := DraftNotes(NotesFacts{Subjects: []string{"chore: tidy", "ci: cache"}}); !strings.HasPrefix(got, "Maintenance release") {
		t.Fatalf("a release of chores: %q", got)
	}
	var many []string
	for i := 0; i < 50; i++ {
		many = append(many, fmt.Sprintf("fix: problem %d", i))
	}
	long := DraftNotes(NotesFacts{Subjects: many})
	if strings.Count(long, "\n- ") != maxNotesLines || !strings.Contains(long, "And 10 more changes.") {
		t.Fatalf("notes are not capped:\n%s", long)
	}
}

func TestGithubRepoPinsEveryGhCall(t *testing.T) {
	cases := map[string]string{
		"https://github.com/DiamondForgeFr/moltenterm.git": "DiamondForgeFr/moltenterm",
		"https://github.com/acme/app":                      "acme/app",
		"git@github.com:acme/app.git":                      "acme/app",
		"ssh://git@github.com/acme/app.git":                "acme/app",
		"https://github.example.com/acme/app.git":          "github.example.com/acme/app",
		"/tmp/origin.git":                                  "",
		"https://gitlab.com/acme/app.git":                  "",
	}
	for url, want := range cases {
		if got := GithubRepo(url); got != want {
			t.Errorf("GithubRepo(%q) = %q, want %q", url, got, want)
		}
	}
	if got := strings.Join(ghArgs("acme/app", []string{"run", "list", "--workflow", "ci.yml"}), " "); got != "run list --workflow ci.yml --repo acme/app" {
		t.Errorf("run list: %s", got)
	}
	if got := strings.Join(ghArgs("acme/app", []string{"api", "repos/{owner}/{repo}/milestones?state=open"}), " "); got != "api repos/acme/app/milestones?state=open" {
		t.Errorf("api: %s", got)
	}
	if got := strings.Join(ghArgs("ghe.example/acme/app", []string{"api", "repos/{owner}/{repo}/milestones"}), " "); got != "api repos/acme/app/milestones --hostname ghe.example" {
		t.Errorf("api on an enterprise host: %s", got)
	}
	if got := ghArgs("", []string{"pr", "list"}); len(got) != 2 {
		t.Errorf("no repository read: %v", got)
	}
}

func TestCiVerdict(t *testing.T) {
	cases := []struct {
		runs []CiRun
		want string
	}{
		{nil, CiMissing},
		{[]CiRun{{Status: "completed", Conclusion: "cancelled"}}, CiMissing},
		{[]CiRun{{Status: "completed", Conclusion: "failure"}}, CiRed},
		{[]CiRun{{Status: "completed", Conclusion: "failure"}, {Status: "completed", Conclusion: "success"}}, CiGreen},
		{[]CiRun{{Status: "completed", Conclusion: "failure"}, {Status: "in_progress"}}, CiRunning},
		{[]CiRun{{Status: "queued"}}, CiRunning},
	}
	for i, c := range cases {
		if got := CiVerdict(c.runs); got != c.want {
			t.Errorf("case %d: %s, want %s", i, got, c.want)
		}
	}
}

func TestPickMilestone(t *testing.T) {
	list := []githubMilestone{{Number: 1, Title: "Later"}, {Number: 2, Title: "v1"}, {Number: 3, Title: "Milestone v1.2.0"}}
	if m := pickMilestone(list, "1.2.0"); m == nil || m.Number != 3 {
		t.Fatalf("exact title: %+v", m)
	}
	if m := pickMilestone(list, "1.3.0"); m == nil || m.Number != 2 {
		t.Fatalf("version line: %+v", m)
	}
	if m := pickMilestone(list, "2.0.0"); m != nil {
		t.Fatalf("no milestone may stand in for another version: %+v", m)
	}
	if MilestoneKey("Milestone V2.0.0") != "2.0.0" || MilestoneKey("Later") != "later" {
		t.Fatalf("milestone keys")
	}
}

// MoltenTerm's own pipeline declares its releases with the generic commands, a phase on every step and a confirm on
// the cut, so that Mission Control runs them as the release contract says.
func TestMoltentermReleaseSteps(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "..")
	report := molten.ValidatePipeline(root)
	if !report.Valid || len(report.Warnings) > 0 {
		t.Fatalf("pipeline: errors %v, warnings %v", report.Errors, report.Warnings)
	}
	release := report.Pipeline.Release
	if release == nil {
		t.Fatalf("no release steps")
	}
	for name, steps := range map[string][]molten.PipelineStep{"rc": release.Rc, "public": release.Public} {
		phases := []string{}
		confirms := 0
		for _, step := range steps {
			if !strings.HasPrefix(step.Run, "molten release ") {
				t.Errorf("%s step %s does not run a molten release command: %s", name, step.Id, step.Run)
			}
			phases = append(phases, step.Phase)
			if step.Confirm != "" {
				confirms++
				if step.Phase != "cut" {
					t.Errorf("%s: the confirm is on %s, not on the cut", name, step.Id)
				}
			}
		}
		want := "prepare prepare cut back"
		if name == "public" {
			want = "prepare prepare cut publish back"
		}
		if strings.Join(phases, " ") != want || confirms != 1 {
			t.Errorf("%s phases %v (%d confirm), want %s and one confirm", name, phases, confirms, want)
		}
	}
	if report.Pipeline.Versions == nil || report.Pipeline.Versions.TagPrefix != "v" || report.Pipeline.Versions.Notes != DefaultNotesPath {
		t.Fatalf("versions: %+v", report.Pipeline.Versions)
	}
}
