// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// #896: an agent fixing a PR's CI is not green when its turn ends; MoltenTerm says when it is.
func TestHeldAgentIsNotGreenWhenItStops(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.states.hold("b1", molten.AgentStateWorking, "Fixing the CI of #7", uimsg.Make("agentHold.fixing", "number", "7"))
	if got := h.info("b1"); got.State != molten.AgentStateWorking || got.MessageText == nil || got.MessageText.Code != "agentHold.fixing" {
		t.Fatalf("a held agent at its prompt shows the hold: %+v", got)
	}
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := h.info("b1"); got.State != molten.AgentStateWorking || got.MessageText == nil || got.MessageText.Code != "agentHold.fixing" {
		t.Fatalf("a working agent says what it works on: %+v", got)
	}
	if err := h.report("b1", molten.AgentStateDone, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("agent stopped, PR still red: not green, got %q", got)
	}
	if len(h.notices) != 0 {
		t.Fatalf("no \"is done\" notification while held: %v", h.notices)
	}
	h.out("b1", "\x1b]9;Task finished\x07")
	if got := h.state("b1"); got != molten.AgentStateWorking || len(h.recorded) != 0 {
		t.Fatalf("the agent's own done signal neither turns it green nor notifies: %q %v", got, h.recorded)
	}
	h.states.hold("b1", molten.AgentStateWorking, "Waiting for the CI of #7", uimsg.Make("agentHold.ci", "number", "7"))
	if got := h.info("b1"); got.MessageText.Code != "agentHold.ci" {
		t.Fatalf("waiting for the CI: %+v", got)
	}
	h.states.release("b1", molten.AgentStateDone, "The CI of #7 passes", uimsg.Make("agentHold.green", "number", "7"))
	got := h.info("b1")
	if got.State != molten.AgentStateDone || got.MessageText == nil || got.MessageText.Code != "agentHold.green" {
		t.Fatalf("PR green: green, with MoltenTerm's words: %+v", got)
	}
	if !h.states.seen("b1", got.Version) || h.state("b1") != molten.AgentStateIdle {
		t.Fatalf("the released done clears when seen, as any other")
	}
}

func TestHeldAgentThatAsksNeedsYou(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.states.hold("b1", molten.AgentStateWorking, "Fixing the CI of #7", nil)
	if err := h.report("b1", molten.AgentStateWaiting, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("the agent asks: needs you, got %q", got)
	}
	if len(h.notices) != 1 {
		t.Fatalf("its question keeps its notification: %v", h.notices)
	}
	h.states.hold("b1", molten.AgentStateWaiting, "Still failing: Go", nil)
	h.states.input("b1", []byte("yes\r"))
	if got := h.info("b1"); got.State != molten.AgentStateWaiting || got.Message != "Still failing: Go" {
		t.Fatalf("PR red after the agent stopped: needs you with the reason, got %+v", got)
	}
	h.states.release("b1", "", "", nil)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("a release without a state leaves the agent's own, got %q", got)
	}
	h.states.forget("b1")
	if len(h.states.holds) != 0 {
		t.Fatalf("a closed block drops its hold")
	}
}
