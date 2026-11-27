// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"path/filepath"
	"reflect"
	"testing"
)

func starterTrees(base string) []treeEntry {
	return []treeEntry{
		{path: filepath.Join(base, "Project"), branch: "develop"},
		{path: filepath.Join(base, "Project-1984"), branch: "fix/1984-sensitive-frame-click"},
		{path: filepath.Join(base, "Project-1985"), branch: "fix/1985-other"},
	}
}

// #2572: the first session seen at work in a worktree started its work, and keeps it while its terminal runs: the
// worktree's ticket stays that session's when nobody works in it any more, and an anonymous background agent there is
// named after it.
func TestStarterBookKeepsTheFirstLead(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	trees := starterTrees(base)
	book := MakeStarterBook(filepath.Join(base, "data", StartersFileName))
	live := map[string]bool{"lead": true, "other": true}
	sub := BranchAgent{Kind: UpcomingAgentSubagent, Worktree: trees[1].path, Branch: trees[1].branch, ParentBlockId: "lead", State: "running"}
	got := book.Note(trees, []BranchAgent{sub}, live, 1)
	if !reflect.DeepEqual(got, map[string]string{trees[1].path: "lead"}) {
		t.Fatalf("first lead: %v", got)
	}
	later := BranchAgent{Kind: UpcomingAgentPanel, Worktree: trees[1].path, Branch: trees[1].branch, BlockId: "other"}
	visitor := BranchAgent{Kind: UpcomingAgentPanel, Worktree: trees[2].path, Branch: trees[2].branch, BlockId: "other", Visiting: true}
	if got := book.Note(trees, []BranchAgent{later, visitor}, live, 2); !reflect.DeepEqual(got, map[string]string{trees[1].path: "lead"}) {
		t.Errorf("a later session or a visitor took the worktree: %v", got)
	}

	reread := MakeStarterBook(filepath.Join(base, "data", StartersFileName))
	if got := reread.Note(trees, nil, live, 3); !reflect.DeepEqual(got, map[string]string{trees[1].path: "lead"}) {
		t.Errorf("the record does not outlive wavesrv: %v", got)
	}
	if got := reread.Note(trees, nil, map[string]bool{"other": true}, 4); len(got) != 0 {
		t.Errorf("a closed terminal still holds its worktree: %v", got)
	}

	anon := BranchAgent{Kind: UpcomingAgentBackground, Worktree: trees[1].path, Branch: trees[1].branch}
	signed := BranchAgent{Kind: UpcomingAgentBackground, Worktree: trees[1].path, Branch: trees[1].branch, Signed: true, FirstName: "Lina"}
	places := []AgentPlace{{BlockId: "lead", Agent: "kimi", FirstName: "Victor"}}
	agents, list := WithStarters(trees, []BranchAgent{anon, signed}, places, map[string]string{trees[1].path: "lead"})
	if agents[0].ParentBlockId != "lead" || agents[0].ParentFirstName != "Victor" {
		t.Errorf("anonymous background agent not named after its worktree's starter: %+v", agents[0])
	}
	if agents[1].ParentBlockId != "" {
		t.Errorf("a signed agent was renamed: %+v", agents[1])
	}
	want := []UpcomingStarter{{Branch: trees[1].branch, Worktree: trees[1].path, BlockId: "lead"}}
	if !reflect.DeepEqual(list, want) {
		t.Errorf("starters: %+v, want %+v", list, want)
	}
}
