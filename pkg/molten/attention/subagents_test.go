// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// hookRun feeds hook inputs through `molten agent hook`'s handler into the states, as wavesrv's route does.
func (h *agentHarness) hookRun(t *testing.T, block string, inputs ...string) {
	t.Helper()
	h.hookRunAs(t, "claude", block, inputs...)
}

func (h *agentHarness) hookRunAs(t *testing.T, agent string, block string, inputs ...string) {
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
		if err := agenthook.RunHookEvent(agenthook.ReadHookInput(strings.NewReader(input)), agent, block, call); err != nil {
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

func subHook(event string, id string) string {
	switch event {
	case agenthook.HookEventSubagentStart:
		return fmt.Sprintf(`{"hook_event_name":"SubagentStart","session_id":"s","turn_id":"t","agent_id":%q,"agent_type":"sf-light"}`, id)
	case agenthook.HookEventSubagentStop:
		return fmt.Sprintf(`{"hook_event_name":"SubagentStop","session_id":"s","turn_id":"t","agent_id":%q,"agent_type":"sf-light"}`, id)
	}
	return fmt.Sprintf(`{"hook_event_name":"PostToolUse","session_id":"s","turn_id":"t","agent_id":%q,"agent_type":"sf-light","tool_name":"exec_command"}`, id)
}

// wantNoSubagents: the run counts none and the pane shows the main session's own state, without the background loader
// or "N sub-agents running".
func wantNoSubagents(t *testing.T, h *agentHarness, block string, state string) {
	t.Helper()
	run, _ := h.states.runOf(block)
	if run.State != state || run.Subagents != 0 {
		t.Fatalf("run %+v, want %s without sub-agents", run, state)
	}
	info := h.info(block)
	if info.State != state || info.Background || info.Subagents != 0 || info.MessageText != nil {
		t.Fatalf("published %+v, want %s without sub-agents", info, state)
	}
}

// #1771: Codex's sub-agents finish their task and wait for the parent's next message, so their SubagentStop may never
// come; Claude Code's may be lost too. The parent's end of turn forgets them: count, loader and list agree.
func TestStaleSubagentsEndWithTheParentsTurn(t *testing.T) {
	for _, agent := range []string{molten.AgentIdCodex, molten.AgentIdClaude} {
		h := makeAgentHarness()
		h.hookRunAs(t, agent, "b1", hookMainPrompt, hookMainTool)
		for _, id := range []string{"019a-sub-1", "019a-sub-2", "019a-sub-3"} {
			h.hookRunAs(t, agent, "b1", subHook(agenthook.HookEventSubagentStart, id), subHook("", id), subHook("", id))
		}
		if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateWorking || run.Subagents != 3 {
			t.Fatalf("%s: three sub-agents at work: %+v", agent, run)
		}
		h.hookRunAs(t, agent, "b1", hookMainStop)
		wantNoSubagents(t, h, "b1", molten.AgentStateDone)

		// A late stop of a forgotten one changes nothing.
		h.hookRunAs(t, agent, "b1", subHook(agenthook.HookEventSubagentStop, "019a-sub-2"))
		wantNoSubagents(t, h, "b1", molten.AgentStateDone)
	}
}

// A sub-agent that still runs after the parent's turn reports its next tool and shows again in the background; when
// its stop is lost too, the parent's next turn end forgets it.
func TestSubagentStillRunningCountsAgainAfterTheTurn(t *testing.T) {
	for _, agent := range []string{molten.AgentIdCodex, molten.AgentIdClaude} {
		h := makeAgentHarness()
		h.hookRunAs(t, agent, "b1", hookMainPrompt, subHook(agenthook.HookEventSubagentStart, "a-1"), hookMainStop)
		wantNoSubagents(t, h, "b1", molten.AgentStateDone)
		h.hookRunAs(t, agent, "b1", subHook("", "a-1"))
		info := h.info("b1")
		if info.State != molten.AgentStateWorking || !info.Background || info.Subagents != 1 {
			t.Fatalf("%s: a sub-agent still at work after the turn: %+v", agent, info)
		}
		h.hookRunAs(t, agent, "b1", hookMainPrompt, hookMainStop)
		wantNoSubagents(t, h, "b1", molten.AgentStateDone)
	}
}

// The main session's error and idle end its turn too; its waiting does not.
func TestSubagentsOutliveOnlyTheTurn(t *testing.T) {
	for _, end := range []string{molten.AgentStateError, molten.AgentStateIdle} {
		h := makeAgentHarness()
		h.hookRunAs(t, molten.AgentIdCodex, "b1", hookMainPrompt, subHook(agenthook.HookEventSubagentStart, "a-1"))
		h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWaiting, Agent: molten.AgentIdCodex})
		if run, _ := h.states.runOf("b1"); run.Subagents != 1 {
			t.Fatalf("waiting keeps the turn's sub-agents: %+v", run)
		}
		h.send(molten.AgentStateRequest{BlockId: "b1", State: end, Agent: molten.AgentIdCodex})
		wantNoSubagents(t, h, "b1", end)
	}
	// Codex's notify, the fallback that only sees turns end, ends it as well.
	h := makeAgentHarness()
	h.hookRunAs(t, molten.AgentIdCodex, "b1", subHook(agenthook.HookEventSubagentStart, "a-1"))
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone, Agent: molten.AgentIdCodex, TurnEnd: true})
	wantNoSubagents(t, h, "b1", molten.AgentStateDone)
}

// An interrupted turn reports no end, nor its sub-agents' stops: once the pane settles idle, they are forgotten.
func TestInterruptedTurnForgetsItsSubagents(t *testing.T) {
	h := hookedWorking(t)
	if _, _, err := h.states.report(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", Subagent: "a-1"}); err != nil {
		t.Fatal(err)
	}
	h.states.input("b1", []byte("\x1b"))
	h.clock = h.clock.Add(50 * time.Millisecond)
	h.out("b1", interruptedLine)
	if run, _ := h.states.runOf("b1"); run.Subagents != 1 {
		t.Fatalf("until the pane settles, the turn may go on: %+v", run)
	}
	h.settle(activityQuiet + time.Second)
	wantNoSubagents(t, h, "b1", molten.AgentStateIdle)
}
