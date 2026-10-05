// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const spinnerFrame = "\x1b[2K\r✻ Thinking… (3s · esc to interrupt)"

// stream sends a spinner frame every step for dur, as an agent working on a turn does.
func (h *agentHarness) stream(block string, step time.Duration, dur time.Duration) {
	for elapsed := time.Duration(0); elapsed < dur; elapsed += step {
		h.out(block, spinnerFrame)
		h.clock = h.clock.Add(step)
	}
}

func (h *agentHarness) settle(after time.Duration) {
	h.clock = h.clock.Add(after)
	h.states.settleActivity()
}

func TestActivitySustainedOutputWorksThenSettles(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude")+"Welcome to Claude Code")
	h.stream("b1", 100*time.Millisecond, activitySustain-200*time.Millisecond)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("output shorter than the sustain is no work yet, got %q", got)
	}
	h.stream("b1", 100*time.Millisecond, time.Second)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("sustained output means working, got %q", got)
	}
	// Spinner frames a second apart (the elapsed-time counter only) keep it working.
	h.stream("b1", time.Second, 10*time.Second)
	h.states.settleActivity()
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("output still coming keeps it working, got %q", got)
	}
	h.settle(activityQuiet - 2*time.Second)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("a short pause is no end of the turn, got %q", got)
	}
	h.settle(2 * time.Second)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("quiet output goes back to idle by itself, got %q", got)
	}
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("an agent at its prompt stays idle, got %q", got)
	}
}

func TestActivityIgnoresTypingEcho(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.clock = h.clock.Add(time.Second)
	for i := 0; i < 40; i++ {
		h.states.input("b1", []byte("a"))
		h.clock = h.clock.Add(30 * time.Millisecond)
		h.out("b1", "a")
		h.clock = h.clock.Add(170 * time.Millisecond)
	}
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("8s of typing echo is no work, got %q", got)
	}
	h.states.input("b1", []byte("\r"))
	h.clock = h.clock.Add(50 * time.Millisecond)
	h.out("b1", "\r\n")
	h.clock = h.clock.Add(activityEchoWindow)
	h.stream("b1", 100*time.Millisecond, activitySustain+200*time.Millisecond)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("the turn after Enter is work, got %q", got)
	}
}

func TestActivityIgnoresOneOffBursts(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("codex"))
	h.clock = h.clock.Add(5 * time.Second)
	for i := 0; i < 30; i++ {
		h.out("b1", spinnerFrame)
		h.clock = h.clock.Add(3 * time.Millisecond)
	}
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("one burst is a redraw, got %q", got)
	}
	// Redraws a couple of seconds apart never join into one run.
	for i := 0; i < 10; i++ {
		h.clock = h.clock.Add(activityGap + 500*time.Millisecond)
		h.out("b1", spinnerFrame)
		h.out("b1", spinnerFrame)
	}
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("separate redraws are no run, got %q", got)
	}
	// A resize dragged for seconds: each redraw follows a resize.
	h.clock = h.clock.Add(5 * time.Second)
	for i := 0; i < 50; i++ {
		h.states.resized("b1")
		h.clock = h.clock.Add(20 * time.Millisecond)
		h.out("b1", spinnerFrame)
		h.clock = h.clock.Add(60 * time.Millisecond)
	}
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("a resize's redraws are no work, got %q", got)
	}
}

func TestActivityIgnoredOnceHooksReport(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.stream("b1", 100*time.Millisecond, 3*time.Second)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("before any hook, output means working, got %q", got)
	}
	h.report("b1", molten.AgentStateWorking, "")
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("a hook's working is not ended by quiet output, got %q", got)
	}
	h.report("b1", molten.AgentStateDone, "")
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	if got := h.state("b1"); got != molten.AgentStateDone {
		t.Fatalf("the hooks are authoritative, got %q", got)
	}
	h.states.input("b1", []byte("\r"))
	h.clock = h.clock.Add(time.Second)
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("a hooked pane gets no working from output, got %q", got)
	}
	// The same agent run again in the pane keeps its hooks.
	h.out("b1", doneMark(0)+promptMark+cmdMark("claude"))
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("a new run of the hooked agent ignores output too, got %q", got)
	}
	// Another agent in the same pane has not reported: its output counts.
	h.out("b1", doneMark(0)+promptMark+cmdMark("codex"))
	h.stream("b1", 100*time.Millisecond, 3*time.Second)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("an agent without hooks in a pane that had some, got %q", got)
	}
	h.states.forget("b1")
	if len(h.states.panes) != 0 {
		t.Fatalf("a closed block keeps no activity: %v", h.states.panes)
	}
}

func TestActivityKeepsWaitingUntilAnswered(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.stream("b1", 100*time.Millisecond, 3*time.Second)
	h.out("b1", "\x1b]9;Claude needs your permission to use Bash\x07")
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("the notification makes it wait, got %q", got)
	}
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	h.settle(time.Minute)
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("output does not end waiting, nor does quiet, got %q", got)
	}
	h.states.input("b1", []byte("\r"))
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("Enter answers, got %q", got)
	}
	h.clock = h.clock.Add(100 * time.Millisecond)
	h.stream("b1", 100*time.Millisecond, 3*time.Second)
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("the agent at work again after the answer, got %q", got)
	}
}

func TestActivityWithoutAgent(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("make build"))
	h.states.input("b1", []byte("x"))
	h.stream("b1", 100*time.Millisecond, 5*time.Second)
	if got := h.state("b1"); got != "" {
		t.Fatalf("a plain command has no state, got %q", got)
	}
	if len(h.states.panes) != 0 {
		t.Fatalf("output without an agent keeps nothing: %v", h.states.panes)
	}
}
