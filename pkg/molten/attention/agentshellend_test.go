// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// waitingAgents counts what the foreman's badge counts from the published states: the blocks whose last state is waiting
// or error, a cleared block counting no more.
func waitingAgents(published []molten.AgentStateInfo) int {
	last := map[string]molten.AgentStateInfo{}
	for _, info := range published {
		last[info.BlockId] = info
	}
	count := 0
	for _, info := range last {
		if !info.Cleared && (info.State == molten.AgentStateWaiting || info.State == molten.AgentStateError) {
			count++
		}
	}
	return count
}

func (h *agentHarness) waitingOn(t *testing.T, block string) {
	t.Helper()
	if err := h.report(block, molten.AgentStateWaiting, "claude"); err != nil {
		t.Fatal(err)
	}
	h.states.flush()
	if n := waitingAgents(h.published); n != 1 {
		t.Fatalf("the badge counts %d agents before the end, want 1", n)
	}
}

func (h *agentHarness) endedOn(t *testing.T, block string, how string) {
	t.Helper()
	h.states.flush()
	if n := waitingAgents(h.published); n != 0 {
		t.Errorf("%s: the badge still counts %d agents", how, n)
	}
	if _, ok := h.states.runOf(block); ok {
		t.Errorf("%s: the run is still recorded", how)
	}
}

// A waiting session that ends leaves the badge at once (#1920): ended through wavesrv (its job done, the pane staying
// as an ended terminal), its command exiting, a plain shell's process ending, or its pane closed.
func TestShellEndClearsWaitingAgent(t *testing.T) {
	ends := []struct {
		name  string
		event wps.WaveEvent
	}{
		{"session ended through wavesrv", wps.WaveEvent{Event: wps.Event_BlockJobStatus, Data: map[string]any{"blockid": "b1", "jobid": "j1", "status": "done"}}},
		{"session's shell exited", wps.WaveEvent{Event: wps.Event_BlockJobStatus, Data: map[string]any{"blockid": "b1", "jobid": "j1", "status": "connected", "cmdexitts": 1234}}},
		{"plain shell ended", wps.WaveEvent{Event: wps.Event_ControllerStatus, Data: map[string]any{"blockid": "b1", "shellprocstatus": "done", "shellprocexitcode": 0}}},
	}
	for _, end := range ends {
		h := makeAgentHarness()
		h.waitingOn(t, "b1")
		h.states.shellEvent(&end.event)
		h.endedOn(t, "b1", end.name)
	}

	h := makeAgentHarness()
	h.waitingOn(t, "b1")
	h.states.forget("b1")
	h.endedOn(t, "b1", "pane closed")
}

// A live session's status changes end nothing: a reconnect, a disconnected host, a running shell, another block.
func TestShellStatusKeepsLiveAgent(t *testing.T) {
	keeps := []wps.WaveEvent{
		{Event: wps.Event_BlockJobStatus, Data: map[string]any{"blockid": "b1", "jobid": "j1", "status": "connected"}},
		{Event: wps.Event_BlockJobStatus, Data: map[string]any{"blockid": "b1", "jobid": "j1", "status": "disconnected"}},
		{Event: wps.Event_ControllerStatus, Data: map[string]any{"blockid": "b1", "shellprocstatus": "running"}},
		{Event: wps.Event_BlockJobStatus, Data: map[string]any{"blockid": "b2", "jobid": "j2", "status": "done"}},
		{Event: wps.Event_BlockClose, Data: "b1"},
		{Event: wps.Event_BlockJobStatus, Data: "not a status"},
		{Event: wps.Event_BlockJobStatus},
	}
	h := makeAgentHarness()
	h.waitingOn(t, "b1")
	for i := range keeps {
		h.states.shellEvent(&keeps[i])
	}
	h.states.flush()
	if n := waitingAgents(h.published); n != 1 {
		t.Errorf("a live session's status changes moved the badge to %d", n)
	}
	if h.state("b1") != molten.AgentStateWaiting {
		t.Errorf("state %q, want waiting", h.state("b1"))
	}
	h.states.shellEvent(nil)
}

// A hook's agent that exits in a shell without the shell integration (no end of command is marked) leaves the badge
// once the process tree no longer finds it.
func TestAgentExitClearsWaitingHookAgent(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h.clock.UnixMilli()))
	h.waitingOn(t, "b1")
	h.pw.restore()
	h.pw.pass()
	run, state, ok := h.record("b1")
	if !ok || run.Pid != 200 || state != molten.AgentStateWaiting {
		t.Fatalf("the hook's agent is found by the tree, still waiting: %+v %q %v", run, state, ok)
	}
	h.setProcs(shellProc(100, 100))
	h.advance(procFastPeriod)
	h.endedOn(t, "b1", "agent exited")
}

// A hook's agent the process tree never found (a remote terminal, an agent under another name) is not ended by it.
func TestAgentExitKeepsUnfoundHookAgent(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "node", h.clock.UnixMilli()))
	h.waitingOn(t, "b1")
	h.pw.restore()
	h.pw.pass()
	h.advance(procFastPeriod)
	if _, state, ok := h.record("b1"); !ok || state != molten.AgentStateWaiting {
		t.Errorf("a hook's agent the tree never saw is kept: %q %v", state, ok)
	}
}
