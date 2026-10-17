// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

func (f *restartFixture) choose(global string, project string) {
	f.r.env.GlobalAgent = func() string { return global }
	f.r.env.ProjectAgent = func(dir string) string {
		if realOf(dir) == realOf(f.dir) {
			return project
		}
		return ""
	}
}

// #845 AC1: pickAgent honours the project's choice, then the global default, then the order (with the review
// session's agent when nothing was chosen).
func TestPickAgentHonoursTheChoice(t *testing.T) {
	f := makeRestartFixture(t)
	req := f.request()
	cases := []struct {
		name, global, project, session, run, want string
	}{
		{"order", "", "", "", "", molten.AgentIdClaude},
		{"session agent without a choice", "", "", molten.AgentIdCodex, "", molten.AgentIdCodex},
		{"global", molten.AgentIdCodex, "", "", "", molten.AgentIdCodex},
		{"project over global", molten.AgentIdCodex, molten.AgentIdClaude, "", "", molten.AgentIdClaude},
		{"a choice over the session agent", "", molten.AgentIdClaude, molten.AgentIdCodex, "", molten.AgentIdClaude},
		{"the run's pick over everything", molten.AgentIdClaude, molten.AgentIdClaude, "", molten.AgentIdCodex, molten.AgentIdCodex},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f.choose(c.global, c.project)
			f.r.env.SessionAgent = func(ctx context.Context, repo string, number int) string { return c.session }
			req.Agent = c.run
			got, choice := f.r.pickAgent(context.Background(), req)
			if got != c.want || choice.Missing {
				t.Fatalf("got %q %+v", got, choice)
			}
		})
	}
}

// #845 AC1: a chosen agent that is not installed is reported, never replaced: the offer says so and lists the
// installed agents, and a start starts nothing.
func TestMissingChosenAgentIsReported(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.installed[molten.AgentIdCodex] = false
	f.choose("", molten.AgentIdCodex)
	req := f.request()
	req.Start, req.Mode, req.WorkspaceId = false, "", ""
	offer, err := f.r.Restart(context.Background(), req)
	if err != nil || offer.Status != RestartOffer || offer.Agent != "" || !offer.AgentMissing || offer.ChosenAgent != molten.AgentIdCodex {
		t.Fatalf("offer: %+v %v", offer, err)
	}
	if len(offer.Agents) != 2 || !offer.Agents[0].Installed || offer.Agents[1].Installed {
		t.Errorf("agents: %+v", offer.Agents)
	}
	res := f.restart()
	if res.Status != RestartNoAgent || res.Reason != RestartReasonAgentMissing || !strings.Contains(res.Message, "Codex, the coding agent chosen for this project, is not installed") {
		t.Fatalf("start: %+v", res)
	}
	if len(f.opened) != 0 || len(f.tabs) != 0 {
		t.Errorf("nothing starts in its place: opened %v tabs %v", f.opened, f.tabs)
	}
	f.batchStopsOnTheMissingAgent(t)
}

func (f *restartFixture) batchStopsOnTheMissingAgent(t *testing.T) {
	id, choice := f.r.pickAgent(context.Background(), RestartRequest{PrKey: f.k, Dir: f.dir})
	if id != "" || !choice.Missing || choice.ChosenName != "Codex" {
		t.Errorf("batch merge's pick: %q %+v", id, choice)
	}
}

// #845 AC3 (Go side): the dialog's pick for one run starts that agent, whatever the project chose.
func TestRunPickStartsThatAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.choose("", molten.AgentIdCodex)
	req := f.investigateRequest(true)
	req.Agent = molten.AgentIdClaude
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartStarted || res.Agent != molten.AgentIdClaude || res.AgentSource != "run" {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.opened) != 1 || !strings.HasPrefix(f.opened[0], "claude ") {
		t.Errorf("opened %v", f.opened)
	}
	f.opened = nil
	res, err = f.r.AskInvestigate(context.Background(), f.investigateRequest(true))
	if err != nil || res.Agent != molten.AgentIdCodex || len(f.opened) != 1 || !strings.HasPrefix(f.opened[0], "codex ") {
		t.Fatalf("the project's choice: %+v %v %v", res, err, f.opened)
	}
	bad := f.investigateRequest(true)
	bad.Agent = "gemini"
	if _, err := f.r.AskInvestigate(context.Background(), bad); err == nil {
		t.Errorf("an agent the flows cannot start is refused")
	}
}

// #845: an agent already on the branch keeps the work; the result names the chosen one when it differs.
func TestReusedAgentNamesTheChosenOne(t *testing.T) {
	f := makeRestartFixture(t)
	f.choose(molten.AgentIdCodex, "")
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle}
	res := f.askRebase(false)
	if res.Status != RestartSent || res.Agent != molten.AgentIdClaude || res.ChosenAgent != molten.AgentIdCodex || res.ChosenName != "Codex" {
		t.Fatalf("result: %+v", res)
	}
	f.choose(molten.AgentIdClaude, "")
	if res := f.askRebase(false); res.ChosenAgent != "" {
		t.Errorf("the same agent needs no word: %+v", res)
	}
}
