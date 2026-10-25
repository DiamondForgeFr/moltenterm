// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// hookRun feeds hook inputs through `molten agent hook`'s handler into the states, as wavesrv's route does.
func (h *agentHarness) hookRun(t *testing.T, block string, inputs ...string) {
	t.Helper()
	call := func(command string, route string, data any) error {
		if command != agenthook.AgentStateSetCommand {
			return nil
		}
		raw, _ := json.Marshal(data)
		var req molten.AgentStateRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		_, _, err := h.states.report(req)
		return err
	}
	for _, input := range inputs {
		if err := agenthook.RunHookEvent(agenthook.ReadHookInput(strings.NewReader(input)), "claude", block, call); err != nil {
			t.Fatalf("%s: %v", input, err)
		}
	}
}

const (
	hookMainPrompt   = `{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"go"}`
	hookMainTool     = `{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"Bash"}`
	hookMainStop     = `{"hook_event_name":"Stop","session_id":"s"}`
	hookSubStart     = `{"hook_event_name":"SubagentStart","session_id":"s","agent_id":"a-1","agent_type":"general-purpose"}`
	hookSubTool      = `{"hook_event_name":"PostToolUse","session_id":"s","agent_id":"a-1","agent_type":"general-purpose","tool_name":"Read"}`
	hookSubStop      = `{"hook_event_name":"SubagentStop","session_id":"s","agent_id":"a-1","agent_type":"general-purpose","agent_transcript_path":"/t/a-1.jsonl"}`
	hookSubWaiting   = `{"hook_event_name":"Notification","session_id":"s","agent_id":"a-1","notification_type":"permission_prompt","message":"Claude needs your permission"}`
	hookSessionStart = `{"hook_event_name":"SessionStart","session_id":"s2","source":"clear"}`
)

// #1092: the main session's prompt is idle once its turn ended, whatever its sub-agents do; the pane shows their work
// as working in the background.
func TestSubagentHooksLeaveTheMainStateAlone(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "b1", hookMainPrompt, hookMainTool, hookMainStop, hookSubStart, hookSubTool, hookSubTool)
	run, _ := h.states.runOf("b1")
	if run.State != molten.AgentStateDone || run.Subagents != 1 {
		t.Fatalf("after the main Stop, with a sub-agent at work: %+v", run)
	}
	info := h.info("b1")
	if info.State != molten.AgentStateWorking || !info.Background || info.Subagents != 1 || info.MessageText == nil || info.MessageText.Code != "agentState.subagent" {
		t.Fatalf("published %+v", info)
	}

	// The main session's own work is working, sub-agents or not.
	h.hookRun(t, "b1", hookMainPrompt)
	if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateWorking {
		t.Fatalf("main prompt: %+v", run)
	}
	if info := h.info("b1"); info.Background {
		t.Fatalf("the main session works: not background %+v", info)
	}
	h.hookRun(t, "b1", hookMainStop, hookSubStop)
	run, _ = h.states.runOf("b1")
	if run.State != molten.AgentStateDone || run.Subagents != 0 {
		t.Fatalf("sub-agent stopped: %+v", run)
	}
	if info := h.info("b1"); info.State != molten.AgentStateDone || info.Background || info.MessageText != nil {
		t.Fatalf("published after the stop %+v", info)
	}
	if len(h.notices) != 0 {
		t.Fatalf("hooks raise no notice through report: %v", h.notices)
	}
}

// A sub-agent's permission prompt shows in the main session's terminal: the pane waits for the developer.
func TestSubagentWaitingIsTheMainsWaiting(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "b1", hookMainStop, hookSubStart, hookSubWaiting)
	if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateWaiting {
		t.Fatalf("waiting: %+v", run)
	}
}

// A tool hook without agent_id is the main session's (the generic fallback); a new session forgets the old one's
// sub-agents; a sub-agent's report never marks the hooks' done (Codex's notify stays redundant only after a main Stop).
func TestSubagentBookkeeping(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "b1", hookMainStop, hookSubStart)
	h.hookRun(t, "b1", hookSessionStart)
	if run, _ := h.states.runOf("b1"); run.Subagents != 0 {
		t.Fatalf("new session: %+v", run)
	}
	h.hookRun(t, "b1", hookMainTool)
	if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateWorking {
		t.Fatalf("no agent_id: the main session's %+v", run)
	}

	h2 := makeAgentHarness()
	h2.hookRun(t, "b2", hookSubStart, hookSubStop)
	if h2.states.turnEndRedundant(molten.AgentStateRequest{BlockId: "b2", State: molten.AgentStateDone, TurnEnd: true}) {
		t.Fatal("a sub-agent's stop is not the hooks' done")
	}
	for i := 0; i < maxTrackedSubagents+10; i++ {
		_, _, err := h2.states.report(molten.AgentStateRequest{BlockId: "b2", State: molten.AgentStateWorking, Agent: "claude", Subagent: strings.Repeat("x", i+1)})
		if err != nil {
			t.Fatal(err)
		}
	}
	if run, _ := h2.states.runOf("b2"); run.Subagents != maxTrackedSubagents {
		t.Fatalf("bounded: %d", run.Subagents)
	}
}
