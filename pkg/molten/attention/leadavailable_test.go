// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// legacyRun feeds hook inputs through `molten agent state <args>`, the hooks pasted from an earlier agent-states.md
// (`molten agent state working --agent claude` on PostToolUse and UserPromptSubmit, `done` on Stop, `waiting --stdin`
// on Notification), into the states as wavesrv's route does.
func (h *agentHarness) legacyRun(t *testing.T, block string, args string, input string) {
	t.Helper()
	sa, ok := agenthook.ParseStateArgs(strings.Fields(args))
	if !ok {
		t.Fatalf("%q: not a state report", args)
	}
	req, send := agenthook.StateArgsRequest(sa, block, strings.NewReader(input), func(string) string { return "" })
	if !send {
		return
	}
	raw, _ := json.Marshal(req)
	var sent molten.AgentStateRequest
	if err := json.Unmarshal(raw, &sent); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.states.report(sent); err != nil {
		t.Fatalf("%q: %v", args, err)
	}
}

const (
	legacyWorking = "working --agent claude"
	legacyDone    = "done --agent claude"
	legacyWaiting = "waiting --agent claude --stdin"
)

// #2536: a lead whose turn ended, with a background sub-agent at work, has a free prompt: its run (what handoffs, page
// comments and agents' messages read) is done, while the pane and the power setting still see the sub-agent's work.
func TestLeadWithABackgroundSubagentIsAvailable(t *testing.T) {
	h := makeAgentHarness()
	h.legacyRun(t, "lead", legacyWorking, hookMainPrompt)
	h.legacyRun(t, "lead", legacyWorking, hookMainTool)
	h.legacyRun(t, "lead", legacyDone, hookMainStop)
	h.hookRun(t, "lead", hookSubStart)
	h.legacyRun(t, "lead", legacyWorking, hookSubTool)
	h.legacyRun(t, "lead", legacyWorking, hookSubTool)

	run, _ := h.states.runOf("lead")
	if run.State != molten.AgentStateDone {
		t.Fatalf("the lead's turn ended: its prompt is free, got %+v", run)
	}
	if run.Subagents != 1 {
		t.Fatalf("the power setting counts the sub-agent (run.Subagents): %+v", run)
	}
	if info := h.info("lead"); info.State != molten.AgentStateWorking || !info.Background || info.Subagents != 1 {
		t.Fatalf("the pane shows the sub-agent's work in the background: %+v", info)
	}
}

// The same with only the old hooks: no SubagentStart, the sub-agent is known from its tools.
func TestLeadWithOnlyOldHooksIsAvailable(t *testing.T) {
	h := makeAgentHarness()
	h.legacyRun(t, "lead", legacyWorking, hookMainPrompt)
	h.legacyRun(t, "lead", legacyDone, hookMainStop)
	h.legacyRun(t, "lead", legacyWorking, hookSubTool)
	run, _ := h.states.runOf("lead")
	if run.State != molten.AgentStateDone || run.Subagents != 1 {
		t.Fatalf("%+v", run)
	}
}

// Busy means the lead itself: its own turn runs, sub-agents or not.
func TestLeadMidTurnIsBusy(t *testing.T) {
	h := makeAgentHarness()
	h.legacyRun(t, "lead", legacyWorking, hookMainPrompt)
	h.legacyRun(t, "lead", legacyWorking, hookSubTool)
	h.legacyRun(t, "lead", legacyWorking, hookMainTool)
	if run, _ := h.states.runOf("lead"); run.State != molten.AgentStateWorking {
		t.Fatalf("mid-turn: %+v", run)
	}
}

// A permission prompt, the lead's or a sub-agent's, shows in the lead's terminal: busy until the developer answers.
func TestLeadOnAPermissionPromptIsBusy(t *testing.T) {
	h := makeAgentHarness()
	h.legacyRun(t, "lead", legacyWorking, hookMainPrompt)
	h.legacyRun(t, "lead", legacyDone, hookMainStop)
	h.legacyRun(t, "lead", legacyWorking, hookSubTool)
	h.legacyRun(t, "lead", legacyWaiting, hookSubWaiting)
	if run, _ := h.states.runOf("lead"); run.State != molten.AgentStateWaiting {
		t.Fatalf("a sub-agent's permission prompt: %+v", run)
	}
}
