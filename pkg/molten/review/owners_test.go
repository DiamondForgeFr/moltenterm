// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// #1955, FR-REV-022 AC21: the launchers read the index of who works on what before they type, send or start anything.

// index gives the fixture's launchers the agents wavesrv places on the project's branches.
func (f *restartFixture) index(agents ...mission.BranchAgent) {
	f.r.env.BranchAgents = func(ctx context.Context, dir string) ([]mission.BranchAgent, bool) {
		return agents, true
	}
}

// subagent is a sub-agent of Arthur's session in the PR's worktree, in the given state.
func subagentOn(tree string, state string) mission.BranchAgent {
	return mission.BranchAgent{Branch: "feature/9-fix-x", Worktree: realOf(tree), Kind: mission.UpcomingAgentSubagent, Agent: molten.AgentIdClaude,
		ParentBlockId: "lead-block", ParentFirstName: "Arthur", State: state, AgentId: "a1b2c3d4e5f6", Description: "#9 fix x", ActiveAt: 10}
}

func panelOn(tree string, blockId string) mission.BranchAgent {
	return mission.BranchAgent{Branch: "feature/9-fix-x", Worktree: realOf(tree), Kind: mission.UpcomingAgentPanel, BlockId: blockId, Agent: molten.AgentIdClaude}
}

func (f *restartFixture) nothingStarted() {
	f.t.Helper()
	if len(f.opened) != 0 || len(f.tabs) != 0 || len(f.typed) != 0 {
		f.t.Fatalf("nothing is started, typed or sent: opened %v tabs %v typed %v", f.opened, f.tabs, f.typed)
	}
}

func TestDecideOwner(t *testing.T) {
	t.Parallel()
	row := func(kind string, state string, at int64) ownerRow {
		return ownerRow{agent: mission.BranchAgent{Kind: kind, ActiveAt: at}, state: state}
	}
	for _, tc := range []struct {
		name string
		rows []ownerRow
		want string
		kind string
	}{
		{"nobody", nil, OwnerNobody, ""},
		{"only a gone agent", []ownerRow{row(mission.UpcomingAgentSubagent, OwnerGone, 1)}, OwnerNobody, ""},
		{"a sub-agent works", []ownerRow{row(mission.UpcomingAgentSubagent, OwnerWorking, 1)}, OwnerWorking, mission.UpcomingAgentSubagent},
		{"working beats asleep, whatever the kind", []ownerRow{row(mission.UpcomingAgentPanel, OwnerAsleep, 9), row(mission.UpcomingAgentSubagent, OwnerWorking, 1)},
			OwnerWorking, mission.UpcomingAgentSubagent},
		{"a panel wins among the working", []ownerRow{row(mission.UpcomingAgentBackground, OwnerWorking, 9), row(mission.UpcomingAgentPanel, OwnerWorking, 1)},
			OwnerWorking, mission.UpcomingAgentPanel},
		{"asleep panel", []ownerRow{row(mission.UpcomingAgentSubagent, OwnerAsleep, 9), row(mission.UpcomingAgentPanel, OwnerAsleep, 1)},
			OwnerAsleep, mission.UpcomingAgentPanel},
		{"asleep sub-agent", []ownerRow{row(mission.UpcomingAgentSubagent, OwnerAsleep, 1)}, OwnerAsleep, mission.UpcomingAgentSubagent},
	} {
		got, owner := decideOwner(tc.rows)
		if got != tc.want || (tc.kind != "" && owner.agent.Kind != tc.kind) {
			t.Errorf("%s: got %s %+v, want %s %s", tc.name, got, owner, tc.want, tc.kind)
		}
	}
}

func TestNamesWork(t *testing.T) {
	t.Parallel()
	for text, want := range map[string]bool{
		"#9 fix x":               true,
		"Review PR #9 meta":      true,
		"Review PR 9":            true,
		"PR9":                    true,
		"ticket #12 and #9":      true,
		"#90 something else":     false,
		"fix issue 9 by hand":    false,
		"":                       false,
		"see #19":                false,
		"the ninth thing #9.":    true,
		"https://x/pull/9/files": false,
	} {
		if got := namesWork(text, 9, 9); got != want {
			t.Errorf("%q: got %v, want %v", text, got, want)
		}
	}
	if namesWork("#7", 0, 0) {
		t.Error("no ticket and no PR names nothing")
	}
}

// The agents tied to the PR: those on its branch, and a sub-agent in no worktree whose task names it; not a visitor, a
// review session, a finished unplaced sub-agent or another branch's agent.
func TestGateTiesTheAgentsToThePr(t *testing.T) {
	f := makeRestartFixture(t)
	f.review["review-term"] = true
	f.runs["panel"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Rita"}
	f.runs["visitor"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	f.runs["review-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	f.runs["other"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	visitor := panelOn("/t", "visitor")
	visitor.Visiting = true
	other := panelOn("/t", "other")
	other.Branch = "feature/10-other"
	f.index(
		panelOn("/t", "panel"), visitor, panelOn("/t", "review-term"), other,
		panelOn("/t", "closed"),
		mission.BranchAgent{Kind: mission.UpcomingAgentSubagent, State: companion.SubagentRunning, Description: "Review PR #9 meta", ParentBlockId: "lead-block"},
		mission.BranchAgent{Kind: mission.UpcomingAgentSubagent, State: companion.SubagentQuiet, Description: "Review #77 meta", ParentBlockId: "lead-block"},
		mission.BranchAgent{Kind: mission.UpcomingAgentSubagent, State: companion.SubagentDone, Description: "Review PR #9, finished", ParentBlockId: "lead-block"},
		mission.BranchAgent{Kind: mission.UpcomingAgentBackground, Branch: "feature/9-fix-x", Worktree: "/b"},
	)
	g := f.r.gate(context.Background(), f.request())
	var got []string
	for _, row := range g.rows {
		got = append(got, row.agent.Kind+":"+row.agent.BlockId+":"+row.state)
	}
	want := []string{"panel:panel:asleep", "subagent::working", "background::working"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("tied agents %v, want %v", got, want)
	}
}

func TestGateWithoutTheIndexKnowsNobody(t *testing.T) {
	f := makeRestartFixture(t)
	if g := f.r.gate(context.Background(), f.request()); len(g.rows) != 0 {
		t.Fatalf("no index, no row: %+v", g.rows)
	}
	f.r.env.BranchAgents = func(ctx context.Context, dir string) ([]mission.BranchAgent, bool) { return nil, false }
	if g := f.r.gate(context.Background(), f.request()); len(g.rows) != 0 {
		t.Fatalf("an index that cannot be read, no row: %+v", g.rows)
	}
}

// The incident: a sub-agent of Arthur works in the PR's worktree. Every launcher leaves it alone, says who works, and
// starts nothing, however the developer asked (with the confirmation to start included).
func TestEveryLauncherLeavesAWorkingSubagent(t *testing.T) {
	for _, start := range []bool{false, true} {
		for name, ask := range map[string]func(f *restartFixture) RestartResult{
			"rebase": func(f *restartFixture) RestartResult { return f.askRebase(start) },
			"finish": func(f *restartFixture) RestartResult { return f.askFinish(f.finishRequest(start)) },
			"investigate": func(f *restartFixture) RestartResult {
				res, err := f.r.AskInvestigate(context.Background(), f.investigateRequest(start))
				if err != nil {
					f.t.Fatal(err)
				}
				return res
			},
			"restart": func(f *restartFixture) RestartResult {
				f.publishRound()
				req := f.request()
				req.Start = start
				res, err := f.r.Restart(context.Background(), req)
				if err != nil {
					f.t.Fatal(err)
				}
				return res
			},
		} {
			f := makeRestartFixture(t)
			tree := f.agentTreeOnBranch()
			f.arthurRunsIn(f.runs)
			f.index(subagentOn(tree, companion.SubagentRunning))
			res := ask(f)
			if res.Status != RestartBusy || res.Reason != RestartReasonSubagentBusy || !res.Subagent || res.BlockId != "lead-block" || res.FirstName != "Arthur" ||
				res.AgentState != molten.AgentStateWorking {
				t.Fatalf("%s start=%v: %+v", name, start, res)
			}
			if !strings.Contains(res.Message, "sub-agent of Arthur") {
				t.Errorf("%s: the message names the lead: %q", name, res.Message)
			}
			f.nothingStarted()
		}
	}
}

func (f *restartFixture) arthurRunsIn(runs map[string]molten.AgentRunInfo) {
	runs["lead-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Arthur"}
}

// A background agent, probably active, is left alone too; so is a panel placed by the index that the worktree's
// terminals do not list, working or waiting.
func TestLaunchersLeaveABackgroundAgentAndAnIndexedPanel(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.index(mission.BranchAgent{Branch: "feature/9-fix-x", Worktree: realOf(tree), Kind: mission.UpcomingAgentBackground, Agent: molten.AgentIdClaude,
		ParentBlockId: "lead-block", ParentFirstName: "Arthur"})
	res := f.askRebase(true)
	if res.Status != RestartBusy || res.Reason != RestartReasonBackgroundBusy || res.BlockId != "lead-block" {
		t.Fatalf("background: %+v", res)
	}
	f.nothingStarted()

	f.runs["indexed"] = molten.AgentRunInfo{Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateWaiting, FirstName: "Jérôme"}
	f.index(panelOn(tree, "indexed"))
	res = f.askRebase(true)
	if res.Status != RestartBusy || res.Reason != RestartReasonAgentBusy || res.BlockId != "indexed" || res.AgentState != molten.AgentStateWaiting {
		t.Fatalf("panel: %+v", res)
	}
	f.nothingStarted()
}

// Asleep: the sub-agent finished, its lead runs. The task goes to the lead, with a brief that names the sub-agent;
// no new agent, nothing typed anywhere else.
func TestEveryLauncherHandsASleepingSubagentToItsLead(t *testing.T) {
	for name, ask := range map[string]func(f *leadFixture) RestartResult{
		"rebase": func(f *leadFixture) RestartResult { return f.askRebase(false) },
		"finish": func(f *leadFixture) RestartResult { return f.askFinish(f.finishRequest(false)) },
		"investigate": func(f *leadFixture) RestartResult {
			res, err := f.r.AskInvestigate(context.Background(), f.investigateRequest(false))
			if err != nil {
				f.t.Fatal(err)
			}
			return res
		},
		"restart": func(f *leadFixture) RestartResult {
			f.publishRound()
			res, err := f.r.Restart(context.Background(), f.request())
			if err != nil {
				f.t.Fatal(err)
			}
			if f.round().RestartedAt == 0 {
				f.t.Errorf("restart: the round is marked handed over")
			}
			return res
		},
	} {
		f := makeLeadFixture(t)
		tree := f.agentTreeOnBranch()
		f.arthurRuns()
		f.arthurRunsIn(f.runs)
		f.index(subagentOn(tree, companion.SubagentDone))
		res := ask(f)
		if res.Status != RestartSent || !res.Lead || !res.Subagent || res.BlockId != "lead-block" || res.FirstName != "Arthur" || realOf(res.Worktree) != realOf(tree) {
			t.Fatalf("%s: %+v", name, res)
		}
		f.nothingStarted()
		sent := f.sentRequests()
		if len(sent) != 1 || sent[0].ToBlockId != "lead-block" {
			t.Fatalf("%s: one request to the lead: %+v", name, sent)
		}
		if f.queries[0].BlockId != "lead-block" || f.queries[0].ProjectDir != f.dir {
			t.Errorf("%s: the lead is the sub-agent's parent session, in the project: %+v", name, f.queries)
		}
		brief := sent[0].Goal + "\n" + sent[0].Context
		for _, part := range []string{"a1b2c3d4e5f6", "SendMessage", "PR #9", "feature/9-fix-x", "same worktree", "ever merge"} {
			if !strings.Contains(brief, part) {
				t.Errorf("%s: the brief misses %q:\n%s", name, part, brief)
			}
		}
		if name != "finish" && !strings.Contains(brief, filepath.Join(f.dataDir, "molten", "reviews")) {
			t.Errorf("%s: the task names the brief MoltenTerm wrote in its data folder:\n%s", name, brief)
		}
	}
}

// A busy lead gets it queued, as handoffs already are; the answer says so.
func TestASleepingSubagentsBusyLeadGetsItQueued(t *testing.T) {
	f := makeLeadFixture(t)
	tree := f.agentTreeOnBranch()
	f.arthurRuns()
	f.arthurRunsIn(f.runs)
	f.sendOut.Status = agenthandoff.StatusQueued
	f.index(subagentOn(tree, companion.SubagentQuiet))
	res := f.askRebase(true)
	if res.Status != RestartQueued || !res.Subagent || res.FirstName != "Arthur" {
		t.Fatalf("result: %+v", res)
	}
	f.nothingStarted()
}

// Check the agents / Resume without a lead named by the window: the sub-agent's lead is the one asked.
func TestFinishDerivesTheLeadFromTheSleepingSubagent(t *testing.T) {
	f := makeLeadFixture(t)
	tree := f.agentTreeOnBranch()
	f.arthurRuns()
	f.arthurRunsIn(f.runs)
	f.index(subagentOn(tree, companion.SubagentDone))
	req := f.finishRequest(false)
	if req.Lead != nil {
		t.Fatal("the window named no lead")
	}
	res := f.askFinish(req)
	if res.Status != RestartSent || !res.Lead || !res.Subagent {
		t.Fatalf("result: %+v", res)
	}
	brief := f.sentRequests()[0].Context
	for _, part := range []string{"a sub-agent of yours already worked on this branch", "a1b2c3d4e5f6", "SendMessage", "never in a second one"} {
		if !strings.Contains(strings.ToLower(brief), strings.ToLower(part)) {
			t.Errorf("the lead's brief misses %q:\n%s", part, brief)
		}
	}
}

// A lead named by the window that is not the sub-agent's parent is not told about a sub-agent that is not its own.
func TestAnotherLeadIsNotToldAboutASubagentThatIsNotItsOwn(t *testing.T) {
	f := makeLeadFixture(t)
	tree := f.agentTreeOnBranch()
	f.running["bob-block"] = agenthandoff.LeadFound{BlockId: "bob-block", FirstName: "Bob", Agent: molten.AgentIdClaude, AgentName: "Claude Code", TabId: "t", WorkspaceId: "ws-1"}
	f.arthurRunsIn(f.runs)
	f.arthurRuns()
	f.index(subagentOn(tree, companion.SubagentDone))
	req := f.leadRequest()
	req.Lead = &LeadRef{FirstName: "Bob", Agent: "Claude Code"}
	res := f.askFinish(req)
	if res.Status != RestartSent || res.FirstName != "Bob" || res.Subagent {
		t.Fatalf("result: %+v", res)
	}
	if strings.Contains(f.sentRequests()[0].Context, "a1b2c3d4e5f6") {
		t.Error("Bob has no such sub-agent")
	}
}

// Gone: the sub-agent finished and its lead no longer runs; nobody owns the work. The usual offer, then a new agent on
// the developer's confirmation, as before.
func TestAGoneOwnerLeavesTheUsualOfferAndStart(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.index(subagentOn(tree, companion.SubagentDone))
	res := f.askRebase(false)
	if res.Status != RebaseOffer {
		t.Fatalf("offer: %+v", res)
	}
	f.nothingStarted()
	res = f.askRebase(true)
	if res.Status != RestartStarted || len(f.opened) != 1 {
		t.Fatalf("a new agent starts once confirmed: %+v opened %v", res, f.opened)
	}
}

// Nobody ever worked on it: the same.
func TestNobodyLeavesTheUsualOfferAndStart(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentTreeOnBranch()
	f.index()
	if res := f.askRebase(false); res.Status != RebaseOffer {
		t.Fatalf("offer: %+v", res)
	}
	if res := f.askRebase(true); res.Status != RestartStarted {
		t.Fatalf("start: %+v", res)
	}
}

// An idle panel the index names, that the worktree's terminals do not list, is woken with the task.
func TestAnIdlePanelOfTheIndexIsWoken(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.runs["indexed"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone, FirstName: "Rita"}
	f.index(panelOn(tree, "indexed"))
	res := f.askRebase(true)
	if res.Status != RestartSent || res.BlockId != "indexed" || f.typed["indexed"] == "" || len(f.opened) != 0 {
		t.Fatalf("result: %+v typed %v opened %v", res, f.typed, f.opened)
	}
}

// The worktree guard: whatever the verdict, no agent starts in a worktree where the index shows one.
func TestNoAgentStartsInAWorktreeHeldByOne(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.runs["indexed"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Rita"}
	f.typeOuts = map[string]RestartTypeOutcome{"indexed": {Gone: true}}
	f.index(panelOn(tree, "indexed"))
	res := f.askRebase(true)
	if res.Status != RestartBusy || res.Reason != RestartReasonTreeInUse || realOf(res.Worktree) != realOf(tree) || res.BlockId != "indexed" {
		t.Fatalf("result: %+v", res)
	}
	if !strings.Contains(res.Message, "Rita") || len(f.opened) != 0 || len(f.tabs) != 0 {
		t.Fatalf("the refusal names the agent, nothing opened: %q opened %v tabs %v", res.Message, f.opened, f.tabs)
	}
	// Its terminal ended since the index was read: the worktree is free.
	delete(f.runs, "indexed")
	if res := f.askRebase(true); res.Status != RestartStarted {
		t.Fatalf("a worktree no live agent holds takes a new agent: %+v", res)
	}
}

// The guard reaches Restart work and the finish launcher alike, and a sleeping sub-agent whose lead cannot be asked
// holds its worktree.
func TestTheGuardHoldsForRestartAndFinish(t *testing.T) {
	f := makeLeadFixture(t)
	tree := f.agentTreeOnBranch()
	f.arthurRunsIn(f.runs)
	// Arthur runs but is not a lead the handoffs can find: the sub-agent sleeps in the worktree.
	f.index(subagentOn(tree, companion.SubagentDone))
	if res := f.askFinish(f.finishRequest(true)); res.Status != RestartBusy || res.Reason != RestartReasonTreeInUse || !res.Subagent {
		t.Fatalf("finish: %+v", res)
	}
	f.publishRound()
	res, err := f.r.Restart(context.Background(), f.request())
	if err != nil || res.Status != RestartBusy || res.Reason != RestartReasonTreeInUse || res.Round == "" {
		t.Fatalf("restart: %+v %v", res, err)
	}
	f.nothingStarted()
}

// A review session's terminal and a visitor never hold a worktree.
func TestAReviewSessionDoesNotHoldTheWorktree(t *testing.T) {
	f := makeRestartFixture(t)
	tree := f.agentTreeOnBranch()
	f.review["review-term"] = true
	f.runs["review-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	f.index(panelOn(tree, "review-term"))
	if res := f.askRebase(true); res.Status != RestartStarted {
		t.Fatalf("result: %+v", res)
	}
}
