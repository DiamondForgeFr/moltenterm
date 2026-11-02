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

func (f *restartFixture) finishRequest(start bool) FinishRequest {
	req := FinishRequest{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", HeadOid: rebaseHead, Title: "Fix x",
		Conflicts: true, FailedChecks: []string{"build", "lint\nrm -rf /"}, ChangesRequested: true, Start: start}
	if start {
		req.Mode, req.WorkspaceId = AgentModeBackground, "ws-1"
	}
	return req
}

func (f *restartFixture) askFinish(req FinishRequest) RestartResult {
	f.t.Helper()
	res, err := f.r.AskFinish(context.Background(), req)
	if err != nil {
		f.t.Fatalf("ask finish: %v", err)
	}
	return res
}

func checkFinishPrompt(t *testing.T, line string, briefPath string) {
	t.Helper()
	for _, part := range []string{"PR #9", "feature/9-fix-x", "conflicts with develop", "red CI", "changes requested",
		"acceptance criteria", "never merge the PR", "--force-with-lease", briefPath} {
		if !strings.Contains(line, part) {
			t.Errorf("the prompt misses %q: %s", part, line)
		}
	}
	if strings.Contains(line, "\n") || len(line) > 600 {
		t.Errorf("the prompt must be one line that fits the guarded typing path (%d chars): %q", len(line), line)
	}
}

// #954 AC8: the agent on the branch gets what is left, through the guarded typing path, with a brief in the data folder.
func TestAskFinishReachesTheAgentOnTheBranch(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Bruno"}
	res := f.askFinish(f.finishRequest(false))
	if res.Status != RestartSent || res.BlockId != "agent-term" || res.FirstName != "Bruno" || len(f.opened) != 0 {
		t.Fatalf("result: %+v opened %v", res, f.opened)
	}
	checkFinishPrompt(t, f.typed["agent-term"], res.BriefPath)
	if !strings.HasPrefix(res.BriefPath, filepath.Join(f.dataDir, "molten", "reviews")) || !strings.HasSuffix(res.BriefPath, filepath.Join("finish", "9-01234567.md")) {
		t.Errorf("the brief must be in MoltenTerm's data folder, named after the head: %s", res.BriefPath)
	}
	brief := readText(t, res.BriefPath)
	for _, part := range []string{"# Check and finish PR #9", "conflicts with develop", "Failed checks: build, lint rm -rf /",
		"requested changes", "acceptance criteria", "git rebase origin/develop", "Do not approve or merge the PR"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
}

// A busy agent is left alone; with no agent the window is offered the start, nothing starts before the confirmation.
func TestAskFinishLeavesABusyAgentAndOffersWithNone(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Bruno"}
	if res := f.askFinish(f.finishRequest(false)); res.Status != RestartBusy || len(f.typed) != 0 {
		t.Fatalf("a working agent must be left alone: %+v typed %v", res, f.typed)
	}
	delete(f.runs, "agent-term")
	if res := f.askFinish(f.finishRequest(false)); res.Status != RestartOffer || len(f.opened) != 0 {
		t.Fatalf("with no agent the window must be offered the start: %+v opened %v", res, f.opened)
	}
}

// Confirmed, a fresh agent starts out of sight with the finish brief.
func TestAskFinishStartsAnAgentWhenConfirmed(t *testing.T) {
	f := makeRestartFixture(t)
	res := f.askFinish(f.finishRequest(true))
	if res.Status != RestartStarted || res.BlockId != "new-block" || !res.Hidden {
		t.Fatalf("result: %+v", res)
	}
	if len(f.opened) != 1 || !strings.HasPrefix(f.opened[0], "claude -- ") {
		t.Fatalf("one agent started through the shim: %v", f.opened)
	}
	checkFinishPrompt(t, f.opened[0], res.BriefPath)
}

// #1212: a draft its agent stopped before marking ready, in a workflow without Human Testing: the resumed agent marks it
// ready itself once its CI is green, as the project's workflow says, and still never merges it.
func TestAskFinishAsksTheAgentToMarkItsDraftReady(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Bruno"}
	req := f.finishRequest(false)
	req.MarkReady = true
	res := f.askFinish(req)
	if res.Status != RestartSent {
		t.Fatalf("result: %+v", res)
	}
	line := f.typed["agent-term"]
	checkFinishPrompt(t, line, res.BriefPath)
	if !strings.Contains(line, "mark it ready") || !strings.Contains(line, "project's workflow") {
		t.Errorf("the prompt must ask the agent to mark its draft ready: %s", line)
	}
	brief := readText(t, res.BriefPath)
	for _, part := range []string{"mark it ready for review", "move its ticket to the next status", "Do not approve or merge the PR"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	plain := f.askFinish(f.finishRequest(false))
	if strings.Contains(readText(t, plain.BriefPath), "mark it ready") {
		t.Errorf("without markready the brief must not ask to mark the PR ready")
	}
}

func TestAskFinishRefusesBadRequests(t *testing.T) {
	f := makeRestartFixture(t)
	for _, req := range []FinishRequest{
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x"},
		{PrKey: f.k, Dir: f.dir, BaseRef: "develop"},
		{PrKey: f.k, Dir: f.dir, HeadRef: "feature/9-fix-x", BaseRef: "develop", Start: true},
		{PrKey: f.k, Dir: f.dir, HeadRef: "-x", BaseRef: "develop"},
	} {
		if _, err := f.r.AskFinish(context.Background(), req); err == nil {
			t.Errorf("want a refusal for %+v", req)
		}
	}
	l := &routeLink{service: &Service{}}
	if _, err := callAs(l, "proc:block-1", FinishCommand, map[string]any{}); err == nil {
		t.Errorf("a terminal must not ask an agent to finish a PR")
	}
}
