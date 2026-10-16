// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

const rebaseHead = "0123456789abcdef0123456789abcdef01234567"

func (f *restartFixture) rebaseRequest(start bool) RebaseRequest {
	req := RebaseRequest{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", HeadOid: rebaseHead, Title: "Fix x", Start: start}
	if start {
		req.Mode, req.WorkspaceId = AgentModeTogether, "ws-1"
	}
	return req
}

func (f *restartFixture) askRebase(start bool) RestartResult {
	f.t.Helper()
	res, err := f.r.AskRebase(context.Background(), f.rebaseRequest(start))
	if err != nil {
		f.t.Fatalf("ask rebase: %v", err)
	}
	return res
}

func (f *restartFixture) agentTreeOnBranch() string {
	f.t.Helper()
	tree := filepath.Join(f.root, "app-9")
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "worktree", "add", "--quiet", "--track", "-b", "feature/9-fix-x", tree, "origin/feature/9-fix-x")
	return tree
}

func checkRebasePrompt(t *testing.T, line string, briefPath string) {
	t.Helper()
	for _, part := range []string{"PR #9", "feature/9-fix-x", "conflicts with develop", "Rebase it on origin/develop", "never merge develop into the branch", "--force-with-lease", briefPath} {
		if !strings.Contains(line, part) {
			t.Errorf("the prompt misses %q: %s", part, line)
		}
	}
	if len(line) > 600 {
		t.Errorf("the prompt must fit the guarded typing path (%d chars)", len(line))
	}
}

// AC2: the agent working on the branch gets the rebase, by its first name, through the guarded typing path.
func TestAskRebaseReachesTheAgentOnTheBranch(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "review-term"}, {BlockId: "agent-term"}}
	f.review["review-term"] = true
	f.runs["review-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Rita"}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateDone, FirstName: "Jérôme"}
	res := f.askRebase(false)
	if res.Status != RestartSent || res.BlockId != "agent-term" || res.FirstName != "Jérôme" || realOf(res.Worktree) != realOf(tree) {
		t.Fatalf("result: %+v", res)
	}
	if len(f.opened) != 0 || f.typed["review-term"] != "" {
		t.Errorf("no new agent and never the review session: opened %v typed %v", f.opened, f.typed)
	}
	checkRebasePrompt(t, f.typed["agent-term"], res.BriefPath)
	if !strings.HasPrefix(res.BriefPath, filepath.Join(f.dataDir, "molten", "reviews")) || !strings.HasSuffix(res.BriefPath, "9-01234567.md") {
		t.Errorf("the brief must be in MoltenTerm's data folder, named after the head: %s", res.BriefPath)
	}
	brief := readText(t, res.BriefPath)
	for _, part := range []string{"# Rebase PR #9 on develop", "git rebase origin/develop", "Never merge develop into the branch",
		"git push --force-with-lease", "Run the project's checks", "do not approve or merge the PR", rebaseHead} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	if state, _ := f.store.Get(f.k); len(state.Rounds) != 0 {
		t.Errorf("a rebase is not a review round: %+v", state.Rounds)
	}
}

// An agent working on the PR's branch in the main checkout is reached there too.
func TestAskRebaseReachesTheAgentInTheMainCheckout(t *testing.T) {
	f := makeRestartFixture(t)
	f.git(f.dir, "fetch", "--quiet", "origin")
	f.git(f.dir, "checkout", "--quiet", "--track", "-b", "feature/9-fix-x", "origin/feature/9-fix-x")
	f.terms[realOf(f.dir)] = []mission.WorktreeTerminal{{BlockId: "main-term"}}
	f.runs["main-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Paul"}
	res := f.askRebase(false)
	if res.Status != RestartSent || res.FirstName != "Paul" || f.typed["main-term"] == "" {
		t.Fatalf("result: %+v typed %v", res, f.typed)
	}
}

// A busy agent is not interrupted: the window says it works.
func TestAskRebaseLeavesABusyAgent(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Rita"}
	res := f.askRebase(true)
	if res.Status != RestartBusy || res.Reason != RestartReasonAgentBusy || res.FirstName != "Rita" || len(f.typed) != 0 || len(f.opened) != 0 {
		t.Fatalf("result: %+v typed %v opened %v", res, f.typed, f.opened)
	}
}

// AC2: no agent on the branch, the window offers to start one; nothing starts before the developer's confirmation.
func TestAskRebaseOffersToStartAnAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentTreeOnBranch()
	res := f.askRebase(false)
	if res.Status != RebaseOffer || len(f.opened) != 0 || len(f.typed) != 0 {
		t.Fatalf("result: %+v opened %v typed %v", res, f.opened, f.typed)
	}
}

// AC2: confirmed, the Restart work flow makes the worktree and starts the agent with the rebase brief.
func TestAskRebaseStartsAnAgentWhenConfirmed(t *testing.T) {
	f := makeRestartFixture(t)
	res := f.askRebase(true)
	if res.Status != RestartStarted || !res.WorktreeCreated || res.BlockId != "new-block" || res.Agent != molten.AgentIdClaude {
		t.Fatalf("result: %+v", res)
	}
	if branch := f.git(res.Worktree, "rev-parse", "--abbrev-ref", "HEAD"); branch != "feature/9-fix-x" {
		t.Errorf("the worktree is on %s, want the PR's branch", branch)
	}
	if len(f.opened) != 1 || !strings.HasPrefix(f.opened[0], "claude -- ") {
		t.Fatalf("one agent started through the shim: %v", f.opened)
	}
	checkRebasePrompt(t, f.opened[0], res.BriefPath)
}

func TestAskRebaseNeedsTheBranchesAndATabToStart(t *testing.T) {
	f := makeRestartFixture(t)
	for _, req := range []RebaseRequest{
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x"},
		{PrKey: f.k, Dir: f.dir, BaseRef: "develop"},
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", Start: true},
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", Start: true, Mode: AgentModeBackground},
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", Start: true, Mode: "review", WorkspaceId: "ws-1"},
		{PrKey: f.k, Dir: f.dir, HeadRef: "-x", BaseRef: "develop"},
	} {
		if _, err := f.r.AskRebase(context.Background(), req); err == nil {
			t.Errorf("want a refusal for %+v", req)
		}
	}
}

func TestAskRebaseIsAWindowsOnly(t *testing.T) {
	l := &routeLink{service: &Service{}}
	if _, err := callAs(l, "proc:block-1", RebaseCommand, map[string]any{}); err == nil {
		t.Errorf("a terminal must not ask for a rebase")
	}
}
