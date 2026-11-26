// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package sfticket

import (
	"strings"
	"testing"
)

const teamStatuses = `[{"name":"Backlog"},{"name":"Ready"},{"name":"In progress"},{"name":"AI testing"},{"name":"Human testing"},{"name":"In review"},{"name":"Done"}]`

func TestWorkflowOfNeedsAManifestStatusesAndTheCli(t *testing.T) {
	dir := t.TempDir()
	if WorkflowOf(dir) != nil {
		t.Fatal("no manifest, no workflow")
	}
	write(t, dir, ".saasfoundry.json", `{"workflow":{"tool":"github-projects","statuses":`+teamStatuses+`}}`)
	if WorkflowOf(dir) != nil {
		t.Fatal("no CLI, no workflow")
	}
	write(t, dir, ".agents/skills/sf-workflow/"+WorkflowCliName, "#!/bin/bash\n")
	w := WorkflowOf(dir)
	if w == nil || !strings.HasSuffix(w.Cli, ".agents/skills/sf-workflow/"+WorkflowCliName) || len(w.Statuses) != 7 {
		t.Fatalf("workflow %+v", w)
	}
	write(t, dir, ".claude/skills/sf-workflow/"+WorkflowCliName, "#!/bin/bash\n")
	if w := WorkflowOf(dir); w == nil || !strings.HasSuffix(w.Cli, ".claude/skills/sf-workflow/"+WorkflowCliName) {
		t.Fatalf("Claude Code's copy comes first: %+v", w)
	}
	for name, manifest := range map[string]string{
		"no workflow tool": `{"workflow":{"statuses":` + teamStatuses + `}}`,
		"no status":        `{"workflow":{"tool":"github-projects","statuses":[]}}`,
		"blank statuses":   `{"workflow":{"tool":"github-projects","statuses":[{"name":" "},{"name":""}]}}`,
		"no workflow":      `{"manifestVersion":4}`,
		"not JSON":         `{"workflow":`,
	} {
		write(t, dir, ".saasfoundry.json", manifest)
		if WorkflowOf(dir) != nil {
			t.Errorf("%s: a workflow was read", name)
		}
	}
	write(t, dir, ".saasfoundry.json", `{"workflow":{"tool":"jira","statuses":[{"name":"To Do"},{"name":" Done "}]}}`)
	if w := WorkflowOf(dir); w == nil || strings.Join(w.Statuses, "|") != "To Do|Done" {
		t.Fatalf("another tool's board is read too, names trimmed: %+v", w)
	}
}

func TestWorkflowFindsTheStatusesWhateverTheirSpelling(t *testing.T) {
	solo := &Workflow{Statuses: []string{"Backlog", "In Progress", "AI Testing", "In Review", "Done"}}
	team := &Workflow{Statuses: []string{"Backlog", "Ready", "In progress", "AI testing", "Human testing", "In review", "Done"}}
	for _, c := range []struct {
		w      *Workflow
		status string
		name   string
		pos    int
	}{
		{solo, StatusInProgress, "In Progress", 1},
		{solo, StatusAiTesting, "AI Testing", 2},
		{solo, StatusInReview, "In Review", 3},
		{solo, StatusDone, "Done", 4},
		{team, StatusInProgress, "In progress", 2},
		{team, StatusAiTesting, "AI testing", 3},
		{team, StatusInReview, "In review", 5},
		{team, StatusDone, "Done", 6},
	} {
		if name, pos := c.w.Find(c.status); name != c.name || pos != c.pos {
			t.Errorf("%s: %q at %d, want %q at %d", c.status, name, pos, c.name, c.pos)
		}
	}
	lean := &Workflow{Statuses: []string{"Backlog", "In progress", "Done"}}
	if name, pos := lean.Find(StatusAiTesting); name != "" || pos != -1 {
		t.Errorf("a workflow with no AI testing: %q at %d", name, pos)
	}
	if got := team.Position("  HUMAN   Testing "); got != 4 {
		t.Errorf("position of Human testing: %d", got)
	}
	if got := team.Position(""); got != -1 {
		t.Errorf("position of nothing: %d", got)
	}
}

func TestParseCurrentStatus(t *testing.T) {
	out := "\x1b[0;34m═══\x1b[0m\nTicket #2563 is currently in status: AI testing  \n═══\n\n---\nstatus: AI testing\n---\n"
	if got, ok := ParseCurrentStatus(out, 2563); !ok || got != "AI testing" {
		t.Fatalf("status %q %v", got, ok)
	}
	if _, ok := ParseCurrentStatus(out, 25); ok {
		t.Fatal("another ticket's line is not the ticket's")
	}
	if _, ok := ParseCurrentStatus("Error: not found\n", 2563); ok {
		t.Fatal("no line, no status")
	}
	if _, ok := ParseCurrentStatus("The ticket #2563 is currently in status: Done", 2563); ok {
		t.Fatal("only the CLI's own line counts")
	}
}
