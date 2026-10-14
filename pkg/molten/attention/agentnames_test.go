// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentnames"
)

func (h *agentHarness) firstName(block string) string {
	for _, info := range h.states.snapshot() {
		if info.BlockId == block {
			return info.FirstName
		}
	}
	return ""
}

func TestAgentsInTwoPanesGetDifferentNames(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.out("b2", cmdMark("claude"))
	if err := h.report("b3", molten.AgentStateWorking, molten.AgentIdCodex); err != nil {
		t.Fatal(err)
	}
	h.states.processAgent("b4", molten.AgentProcess{Agent: molten.AgentIdClaude, Pid: 42, StartMs: 1}, true)
	seen := map[string]string{}
	for _, b := range []string{"b1", "b2", "b3", "b4"} {
		name := h.firstName(b)
		if name == "" {
			t.Fatalf("%s has no first name", b)
		}
		if other, dup := seen[name]; dup {
			t.Fatalf("%s named %s like %s", b, name, other)
		}
		seen[name] = b
		run, ok := h.states.runOf(b)
		if !ok || run.FirstName != name {
			t.Fatalf("%s: run name %q, state name %q", b, run.FirstName, name)
		}
	}
}

func TestAPaneKeepsItsNameAcrossRunsAndFreesItOnClose(t *testing.T) {
	h := makeAgentHarness()
	h.states.names = agentnames.MakeAllocator([]string{"Alice"})
	h.out("b1", cmdMark("claude"))
	if got := h.firstName("b1"); got != "Alice" {
		t.Fatalf("got %q", got)
	}
	h.out("b1", doneMark(0)+promptMark)
	if _, held := h.states.names.Owner("Alice"); held {
		t.Fatalf("an ended session keeps its name")
	}
	h.out("b1", cmdMark("claude --resume"))
	if got := h.firstName("b1"); got != "Alice" {
		t.Fatalf("resumed session in the same pane got %q", got)
	}
	h.out("b2", cmdMark("codex"))
	if got := h.firstName("b2"); got != "Alice 2" {
		t.Fatalf("exhausted list: got %q", got)
	}
	h.states.forget("b1")
	h.out("b2", doneMark(0)+promptMark)
	h.out("b3", cmdMark("claude"))
	if got := h.firstName("b3"); got != "Alice" {
		t.Fatalf("a freed name is drawn again: got %q", got)
	}
}

func TestHookNoticeNamesTheAgentByFirstName(t *testing.T) {
	h := makeAgentHarness()
	h.states.names = agentnames.MakeAllocator([]string{"Jérôme"})
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWaiting, molten.AgentIdClaude); err != nil {
		t.Fatal(err)
	}
	if len(h.notices) != 1 || h.notices[0] != "warning:Jérôme is waiting for you" {
		t.Fatalf("notices: %v", h.notices)
	}
}

func TestNamedCallbackOnlyForANewName(t *testing.T) {
	h := makeAgentHarness()
	var named []string
	h.states.onNamed = func(blockId string, name string) { named = append(named, blockId+":"+name) }
	h.states.names = agentnames.MakeAllocator([]string{"Alice", "Bruno"})
	h.states.names.Prefer("b1", "Bruno")
	h.out("b1", cmdMark("claude"))
	h.out("b1", doneMark(0)+promptMark)
	h.out("b1", cmdMark("claude"))
	if len(named) != 0 || h.firstName("b1") != "Bruno" {
		t.Fatalf("a remembered name is no new name: %v, %q", named, h.firstName("b1"))
	}
	h.out("b2", cmdMark("claude"))
	if len(named) != 1 || named[0] != "b2:Alice" {
		t.Fatalf("named: %v", named)
	}
}
