// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const settleStopMessage = "Backend stays red, flaky test #1874"

func holdStop(h *agentHarness, block string, message string) {
	h.states.hold(block, molten.AgentStateWaiting, message, uimsg.Make("notif.review.asks", "reason", message))
}

// #1876: an agent that stopped for a decision waits for the developer until someone settles it; the settled stop shows
// idle, with who and why, and only until the agent moves on.
func TestSettledStopShowsIdleWithWhoAndWhy(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	if got := h.states.settleStop("b1", "Arthur", "ok"); got != molten.AgentSettleNone {
		t.Fatalf("no stop is held yet: %q", got)
	}
	holdStop(h, "b1", settleStopMessage)
	if got := h.info("b1"); got.State != molten.AgentStateWaiting || got.Settled != nil {
		t.Fatalf("the stop waits for the developer: %+v", got)
	}
	h.clock = h.clock.Add(time.Minute)
	if got := h.states.settleStop("b1", "Arthur", "flaky, #1874 fixes it"); got != molten.AgentSettleDone {
		t.Fatalf("settled: %q", got)
	}
	got := h.info("b1")
	if got.State != molten.AgentStateIdle || got.Message != "" || got.MessageText != nil {
		t.Fatalf("a settled stop no longer waits and no longer says it asks: %+v", got)
	}
	if got.Settled == nil || got.Settled.By != "Arthur" || got.Settled.Note != "flaky, #1874 fixes it" || got.Settled.At != h.clock.UnixMilli() {
		t.Fatalf("who and why: %+v", got.Settled)
	}
	if !h.states.stopSettled("b1") {
		t.Fatal("the follow reads the settlement")
	}
	// The follow holds the same stop again at its next pass: it stays settled.
	holdStop(h, "b1", settleStopMessage)
	if got := h.info("b1"); got.State != molten.AgentStateIdle || got.Settled == nil {
		t.Fatalf("the same stop held again stays settled: %+v", got)
	}
}

// A settlement belongs to the stop it answers.
func TestASettlementDoesNotOutliveItsStop(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	holdStop(h, "b1", settleStopMessage)
	if got := h.states.settleStop("b1", "", "mine"); got != molten.AgentSettleDone {
		t.Fatalf("settled: %q", got)
	}
	// The clock never moves: the new state must be told apart from the old one without it.
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := h.info("b1"); got.State != molten.AgentStateWorking || got.Settled != nil {
		t.Fatalf("the agent works again: %+v", got)
	}
	if err := h.report("b1", molten.AgentStateDone, "claude"); err != nil {
		t.Fatal(err)
	}
	got := h.info("b1")
	if got.State != molten.AgentStateWaiting || got.Settled != nil || got.Message != settleStopMessage {
		t.Fatalf("it stopped again with the same words: the developer is asked again: %+v", got)
	}
	if h.states.stopSettled("b1") {
		t.Fatal("the old settlement is gone")
	}
}

func TestANewStopReasonAsksAgain(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	holdStop(h, "b1", settleStopMessage)
	h.states.settleStop("b1", "Arthur", "ok")
	holdStop(h, "b1", "Still failing on #7: Go")
	got := h.info("b1")
	if got.State != molten.AgentStateWaiting || got.Message != "Still failing on #7: Go" || got.Settled != nil {
		t.Fatalf("another reason is another stop: %+v", got)
	}
}

// Only a stop MoltenTerm holds is settled: a prompt of the agent's own terminal is answered there.
func TestAnAgentsOwnPromptIsNotSettled(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	holdStop(h, "b1", settleStopMessage)
	if err := h.report("b1", molten.AgentStateWaiting, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := h.states.settleStop("b1", "Arthur", "ok"); got != molten.AgentSettleOwnPrompt {
		t.Fatalf("the agent itself asks: %q", got)
	}
	if got := h.info("b1"); got.State != molten.AgentStateWaiting || got.Settled != nil {
		t.Fatalf("still waiting: %+v", got)
	}
	// A hold that works (fixing the CI) is no stop either.
	h2 := makeAgentHarness()
	h2.out("b1", cmdMark("claude"))
	h2.states.hold("b1", molten.AgentStateWorking, "Fixing the CI of #7", nil)
	if got := h2.states.settleStop("b1", "Arthur", "ok"); got != molten.AgentSettleNone {
		t.Fatalf("a working hold is no stop: %q", got)
	}
}

func TestSettleTextIsOneLineAndCut(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	holdStop(h, "b1", settleStopMessage)
	long := "line one\nline two\t" + strings.Repeat("é", 400)
	note := cleanSettleText(long, molten.AgentSettleNoteMax)
	if strings.ContainsAny(note, "\n\t") || len([]rune(note)) != molten.AgentSettleNoteMax || !strings.HasSuffix(note, "…") {
		t.Fatalf("one line, cut: %q (%d)", note, len([]rune(note)))
	}
	if got := cleanSettleText("  a   b ", 10); got != "a b" {
		t.Fatalf("spaces: %q", got)
	}
	h.states.settleStop("b1", "Arthur", note)
	if got := h.info("b1"); got.Settled == nil || got.Settled.Note != note {
		t.Fatalf("kept: %+v", got.Settled)
	}
}
