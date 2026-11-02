// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// #1172 (FR-REV-022 AC11): a ticket with an open PR shows one card. Its other branches (a local test copy, a copy of
// a ticket the PR closes) are listed on that PR, never Upcoming; the PR's own branch, in an agent worktree, is no
// candidate at all; a ticket without an open PR stays Upcoming.
func TestUpcomingTicketWithAnOpenPrIsNeverUpcoming(t *testing.T) {
	dir := makeGitFlowRepo(t)
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}","fix":"fix/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	branchWithCommit(t, dir, "feature/63-pipeline", "p.txt")
	branchWithCommit(t, dir, "test/63-local", "l.txt")
	branchWithCommit(t, dir, "fix/70-other", "o.txt")
	branchWithCommit(t, dir, "feature/71-copy", "c.txt")
	branchWithCommit(t, dir, "feature/5-plain", "x.txt")
	agentTree := filepath.Join(dir, ".claude", "worktrees", "agent-aec")
	gitRun(t, dir, "worktree", "add", "-q", agentTree, "feature/63-pipeline")
	prs, _ := json.Marshal([]map[string]any{
		{"number": 69, "headRefName": "feature/63-pipeline", "baseRefName": "develop", "isDraft": true},
		{"number": 72, "headRefName": "fix/70-other", "baseRefName": "develop", "closingIssuesReferences": []map[string]any{{"number": 71}}},
	})
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	u := MakeUpcoming(UpcomingEnv{Run: run, Snapshot: func(string) (Snapshot, bool) { return snap, true }})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	upcoming := map[string]bool{}
	for _, b := range answer.Branches {
		upcoming[b.Branch] = true
	}
	for _, branch := range []string{"feature/63-pipeline", "test/63-local", "fix/70-other", "feature/71-copy"} {
		if upcoming[branch] {
			t.Fatalf("%s: a ticket with an open PR is never Upcoming: %+v", branch, answer.Branches)
		}
	}
	if !upcoming["feature/5-plain"] || !upcoming["feature/4-thing"] {
		t.Fatalf("tickets without an open PR stay Upcoming: %+v", answer.Branches)
	}
	others := map[string]UpcomingPrBranch{}
	for _, b := range answer.PrBranches {
		others[b.Branch] = b
	}
	if b := others["test/63-local"]; b.Pr != 69 || b.Ticket != 63 || b.Ahead != 1 || b.Remote {
		t.Fatalf("the local copy is listed on its ticket's PR: %+v", answer.PrBranches)
	}
	if b := others["feature/71-copy"]; b.Pr != 72 || b.Ticket != 71 {
		t.Fatalf("the PR's closing issue names its ticket: %+v", answer.PrBranches)
	}
	if len(answer.PrBranches) != 2 {
		t.Fatalf("only the other branches: %+v", answer.PrBranches)
	}
	if answer.HumanTesting != "" {
		t.Fatalf("no workflow statuses declared: %q", answer.HumanTesting)
	}
}

// #1172: whose turn a draft is depends on the project's workflow: a Solo board has no Human Testing column.
func TestReadHumanTesting(t *testing.T) {
	dir := t.TempDir()
	write := func(sf string) {
		if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if got := readHumanTesting(dir); got != "" {
		t.Fatalf("no manifest: %q", got)
	}
	write(`{"workflow":{"statuses":[{"name":"In Progress"},{"name":"AI Testing"},{"name":"In Review"},{"name":"Done"}]}}`)
	if got := readHumanTesting(dir); got != UpcomingHumanTestingNo {
		t.Fatalf("Solo: %q", got)
	}
	write(`{"workflow":{"statuses":[{"name":"AI Testing"},{"name":"Human  testing"},{"name":"In Review"}]}}`)
	if got := readHumanTesting(dir); got != UpcomingHumanTestingYes {
		t.Fatalf("with Human Testing: %q", got)
	}
	write(`{"workflow":{"branchNaming":{"feature":"feature/{N}-{description}"}}}`)
	if got := readHumanTesting(dir); got != "" {
		t.Fatalf("no statuses: %q", got)
	}
}
