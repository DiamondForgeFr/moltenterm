// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

const (
	tieHeadA = "1111111111111111111111111111111111111111"
	tieHeadB = "2222222222222222222222222222222222222222"
)

func prSnapshot(t *testing.T, prs ...ghReviewPr) Snapshot {
	t.Helper()
	raw, err := json.Marshal(prs)
	if err != nil {
		t.Fatal(err)
	}
	return Snapshot{Github: &GithubSnapshot{State: GithubStateOk, Prs: raw}}
}

// headsRunner answers `git rev-parse HEAD` with the head commit of the worktree it runs in.
func headsRunner(heads map[string]string, calls *[]string) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		*calls = append(*calls, dir)
		if head, ok := heads[dir]; ok && len(args) == 2 && args[0] == "rev-parse" && args[1] == "HEAD" {
			return []byte(head + "\n"), nil
		}
		return nil, fmt.Errorf("no such worktree: %s", dir)
	}
}

// #1955: an agent in a worktree whose branch the host named (worktree-agent-<id>), at a PR's head commit, is on that PR.
func TestTieAgentsToPrsByTheWorktreesHeadCommit(t *testing.T) {
	t.Parallel()
	snap := prSnapshot(t,
		ghReviewPr{Number: 5, HeadRefName: "feature/5-a", HeadRefOid: tieHeadA},
		ghReviewPr{Number: 6, HeadRefName: "feature/6-b", HeadRefOid: tieHeadB},
		ghReviewPr{Number: 7, HeadRefName: "feature/7-fork", HeadRefOid: "3333333333333333333333333333333333333333", IsCrossRepository: true},
	)
	agents := []BranchAgent{
		{Branch: "worktree-agent-ab12", Worktree: "/p/.claude/worktrees/agent-ab12", Kind: UpcomingAgentSubagent, AgentId: "ab12", State: companion.SubagentDone},
		{Branch: "worktree-agent-cd34", Worktree: "/p/.claude/worktrees/agent-cd34", Kind: UpcomingAgentPanel, BlockId: "b1"},
		{Branch: "worktree-agent-ef56", Worktree: "/p/.claude/worktrees/agent-ef56", Kind: UpcomingAgentSubagent},
		{Branch: "worktree-agent-gh78", Worktree: "/p/.claude/worktrees/agent-gh78", Kind: UpcomingAgentSubagent},
		{Branch: "feature/5-a", Worktree: "/p/.claude/worktrees/on-the-branch", Kind: UpcomingAgentSubagent},
		{Branch: "develop", Worktree: "/p", Kind: UpcomingAgentPanel, BlockId: "main"},
		{Branch: "", Kind: UpcomingAgentSubagent, State: companion.SubagentRunning},
	}
	var calls []string
	run := headsRunner(map[string]string{
		"/p/.claude/worktrees/agent-ab12": tieHeadA,
		"/p/.claude/worktrees/agent-cd34": tieHeadB,
		"/p/.claude/worktrees/agent-ef56": "9999999999999999999999999999999999999999",
		"/p/.claude/worktrees/agent-gh78": "3333333333333333333333333333333333333333",
		"/p":                              tieHeadA,
	}, &calls)
	got := tieAgentsToPrs(&gitReader{ctx: context.Background(), run: run, dir: "/p"}, agents, snap, "/p")
	want := []string{"feature/5-a", "feature/6-b", "worktree-agent-ef56", "worktree-agent-gh78", "feature/5-a", "develop", ""}
	for i, a := range got {
		if a.Branch != want[i] {
			t.Errorf("agent %d: branch %q, want %q", i, a.Branch, want[i])
		}
	}
	if agents[0].Branch != "worktree-agent-ab12" {
		t.Error("the answer's agents are copied, never changed in place")
	}
	if got[0].AgentId != "ab12" || got[0].State != companion.SubagentDone || got[0].Worktree != "/p/.claude/worktrees/agent-ab12" {
		t.Errorf("only the branch changes: %+v", got[0])
	}
	for _, dir := range calls {
		if dir == "/p" || dir == "/p/.claude/worktrees/on-the-branch" {
			t.Errorf("the main checkout and a worktree already on a PR's branch are not read: %v", calls)
		}
	}
}

// One read per worktree, however many agents work in it; no open PR, no read.
func TestTieAgentsToPrsReadsEachWorktreeOnce(t *testing.T) {
	t.Parallel()
	snap := prSnapshot(t, ghReviewPr{Number: 5, HeadRefName: "feature/5-a", HeadRefOid: tieHeadA})
	agents := []BranchAgent{
		{Branch: "worktree-agent-ab12", Worktree: "/w", Kind: UpcomingAgentSubagent},
		{Branch: "worktree-agent-ab12", Worktree: "/w", Kind: UpcomingAgentPanel, BlockId: "b1"},
	}
	var calls []string
	run := headsRunner(map[string]string{"/w": tieHeadA}, &calls)
	got := tieAgentsToPrs(&gitReader{ctx: context.Background(), run: run, dir: "/p"}, agents, snap, "/p")
	if got[0].Branch != "feature/5-a" || got[1].Branch != "feature/5-a" || len(calls) != 1 {
		t.Fatalf("both agents tied with one read: %+v, reads %v", got, calls)
	}
	calls = nil
	tieAgentsToPrs(&gitReader{ctx: context.Background(), run: run, dir: "/p"}, agents, Snapshot{}, "/p")
	if len(calls) != 0 {
		t.Fatalf("without the open PRs nothing is read: %v", calls)
	}
}

// The sub-agent's id goes with it to the launchers, which ask its lead to continue it by that id.
func TestSubagentBranchAgentsCarryTheAgentId(t *testing.T) {
	t.Parallel()
	trees := []treeEntry{{path: "/p", branch: "develop"}, {path: "/p/.claude/worktrees/a", branch: "feature/7-a"}}
	sub := func(worktree string, desc string) PaneSubagent {
		return PaneSubagent{ParentBlockId: "parent", ParentFirstName: "Arthur", Agent: "claude", SubagentIdentity: companion.SubagentIdentity{
			AgentId: "a1b2c3", Worktree: worktree, State: companion.SubagentDone, LastWrite: 5, Description: desc,
		}}
	}
	if got := SubagentBranchAgents(trees, nil, []PaneSubagent{sub("/p/.claude/worktrees/a", "#7")}); len(got) != 1 || got[0].AgentId != "a1b2c3" {
		t.Fatalf("placed: %+v", got)
	}
	running := sub("/p", "Review PR #7")
	running.State = companion.SubagentRunning
	if got := UnplacedSubagents(trees, nil, []PaneSubagent{running}); len(got) != 1 || got[0].AgentId != "a1b2c3" {
		t.Fatalf("unplaced: %+v", got)
	}
}

func TestLiveBranchAgentsKnowsNothingBeforeMissionControlStarts(t *testing.T) {
	serialTest(t)
	useLiveReviews(nil)
	if agents, ok := LiveBranchAgents("/p"); ok || agents != nil {
		t.Fatalf("got %+v %v", agents, ok)
	}
}
