// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// #1024: an agent whose terminal is closed or whose shell ended no longer works on the branch, whatever its run record
// said: the action offers to start one, and nothing starts before the developer's click.

func goneOutcome() RestartTypeOutcome {
	return RestartTypeOutcome{Gone: true, Message: "The agent's terminal is closed or its shell ended: nothing was typed.",
		MessageText: uimsg.Make("termupdate.input.terminalgone")}
}

func TestAnalyzeAndResolveOffersAnAgentWhenTheTerminalIsGone(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	f.typeOuts = map[string]RestartTypeOutcome{"agent-term": goneOutcome()}
	res, err := f.r.AskInvestigate(context.Background(), f.investigateRequest(false))
	if err != nil || res.Status != RestartOffer || res.Branch != "feature/9-fix-x" {
		t.Fatalf("the offer to start an agent: %+v %v", res, err)
	}
	if strings.Contains(res.Message, "agent-term") || res.BlockId != "" {
		t.Errorf("no block id in the answer: %+v", res)
	}
	if len(f.opened) != 0 || len(f.tabs) != 0 {
		t.Fatalf("nothing starts before the click: opened %v, tabs %v", f.opened, f.tabs)
	}
	res, err = f.r.AskInvestigate(context.Background(), f.investigateRequest(true))
	if err != nil || res.Status != RestartStarted || len(f.opened) != 1 {
		t.Fatalf("the developer's click starts the agent: %+v %v (opened %v)", res, err, f.opened)
	}
	if !strings.Contains(f.opened[0], res.BriefPath) {
		t.Errorf("the new agent gets the brief %s: %s", res.BriefPath, f.opened[0])
	}
}

func TestRestartReachesTheNextAgentWhenOneTerminalIsGone(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "dead-term"}, {BlockId: "live-term"}}
	f.runs["dead-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Noé"}
	f.runs["live-term"] = molten.AgentRunInfo{Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateIdle, FirstName: "Lina"}
	f.typeOuts = map[string]RestartTypeOutcome{"dead-term": goneOutcome()}
	res := f.restart()
	if res.Status != RestartSent || res.BlockId != "live-term" || res.FirstName != "Lina" || len(f.opened) != 0 {
		t.Fatalf("the live agent takes the work: %+v (opened %v)", res, f.opened)
	}
}

func TestAskRebaseOffersAnAgentWhenTheTerminalIsGone(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	f.typeOuts = map[string]RestartTypeOutcome{"agent-term": goneOutcome()}
	res, err := f.r.AskRebase(context.Background(), f.rebaseRequest(false))
	if err != nil || res.Status != RestartOffer || len(f.opened) != 0 {
		t.Fatalf("result: %+v %v (opened %v)", res, err, f.opened)
	}
}

// A refusal that is not a gone terminal keeps its words for the window.
func TestRefusedPromptCarriesItsText(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	f.typeOuts = map[string]RestartTypeOutcome{"agent-term": {Message: "The terminal did not take the input: x",
		MessageText: uimsg.Make("termupdate.input.nottaken", "detail", "x")}}
	res, err := f.r.AskInvestigate(context.Background(), f.investigateRequest(false))
	if err != nil || res.Status != RestartFailed || res.MessageText == nil || res.MessageText.Code != "termupdate.input.nottaken" {
		t.Fatalf("result: %+v %v", res, err)
	}
}
