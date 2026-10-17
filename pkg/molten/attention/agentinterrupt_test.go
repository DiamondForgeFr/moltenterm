// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const interruptedLine = "\x1b[2K\r⎿  Interrupted · What should Claude do instead?\r\n> "

// hookedWorking: a Claude Code pane whose UserPromptSubmit hook reported working, the user's prompt echoed long ago.
func hookedWorking(t *testing.T) *agentHarness {
	t.Helper()
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.clock = h.clock.Add(time.Second)
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	return h
}

func (h *agentHarness) runState(block string) string {
	run, _ := h.states.runOf(block)
	return run.State
}

func TestInterruptedHookedTurnSettlesIdle(t *testing.T) {
	for _, key := range []string{"\x1b", "\x03"} {
		h := hookedWorking(t)
		h.states.input("b1", []byte(key))
		if got := h.state("b1"); got != molten.AgentStateWorking {
			t.Fatalf("%q alone does not end the turn, got %q", key, got)
		}
		// The agent's redraw right after the interrupt, then nothing: it sits at its prompt.
		h.clock = h.clock.Add(50 * time.Millisecond)
		h.out("b1", interruptedLine)
		h.clock = h.clock.Add(activityEchoWindow)
		h.out("b1", interruptedLine)
		h.settle(activityQuiet - time.Second)
		if got := h.state("b1"); got != molten.AgentStateWorking {
			t.Fatalf("%q: a short pause is no end of the turn yet, got %q", key, got)
		}
		h.settle(time.Second)
		if got := h.runState("b1"); got != molten.AgentStateIdle {
			t.Fatalf("%q: an interrupted agent whose output stays quiet is idle, got %q", key, got)
		}
		h.settle(time.Minute)
		if got := h.state("b1"); got != molten.AgentStateIdle {
			t.Fatalf("%q: it stays idle, got %q", key, got)
		}
	}
}

func TestEscapeWhileStillWorkingKeepsWorking(t *testing.T) {
	h := hookedWorking(t)
	// Escape closes one of the agent's own menus: its turn goes on and its spinner keeps coming.
	h.states.input("b1", []byte("\x1b"))
	h.clock = h.clock.Add(50 * time.Millisecond)
	for i := 0; i < 30; i++ {
		h.stream("b1", time.Second, time.Second)
		h.states.settleActivity()
	}
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("an agent still drawing its spinner stays working, got %q", got)
	}
	// Its next hook takes the state back: quiet output no longer ends it.
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("a hook's working is not ended by quiet output, got %q", got)
	}
	h.report("b1", molten.AgentStateDone, "")
	if got := h.state("b1"); got != molten.AgentStateDone {
		t.Fatalf("the turn's end shows done, got %q", got)
	}
}

func TestInterruptKeysOutsideWorkChangeNothing(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.report("b1", molten.AgentStateWaiting, "claude")
	for _, state := range []string{molten.AgentStateWaiting, molten.AgentStateDone, molten.AgentStateIdle} {
		h.report("b1", state, "")
		h.states.input("b1", []byte("\x1b"))
		h.states.input("b1", []byte("\x03"))
		h.settle(time.Minute)
		if got := h.state("b1"); got != state {
			t.Fatalf("an interrupt key while %s changes nothing, got %q", state, got)
		}
	}
	// Then a turn: the earlier keys left no mark that would end it.
	h.report("b1", molten.AgentStateWorking, "")
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("a hook's working is not ended by quiet output, got %q", got)
	}
}

func TestEscapeSequencesAreNoInterrupt(t *testing.T) {
	h := hookedWorking(t)
	for _, seq := range []string{"\x1b[A", "\x1b[B", "\x1b\x1b", "a\x1b", "\x1b[Z"} {
		h.states.input("b1", []byte(seq))
	}
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("arrow keys and other sequences are no interrupt, got %q", got)
	}
}

func TestInterruptedHeldBlockKeepsHold(t *testing.T) {
	h := hookedWorking(t)
	text := uimsg.Make("mission.fixingci", "number", "7")
	h.states.hold("b1", molten.AgentStateWorking, "Fixing the CI of #7", text)
	h.states.input("b1", []byte("\x1b"))
	h.settle(time.Minute)
	if got := h.runState("b1"); got != molten.AgentStateIdle {
		t.Fatalf("the interrupted agent itself is idle, got %q", got)
	}
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("the hold still shows its state, got %q", got)
	}
}
