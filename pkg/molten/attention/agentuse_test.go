// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentuse"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

func makeUseHarness(t *testing.T) (*agentHarness, *agentUseTracker) {
	t.Helper()
	h := makeAgentHarness()
	tracker := makeAgentUseTracker(h.states, nil)
	tracker.now = func() time.Time { return h.clock }
	return h, tracker
}

// #2341: the use of an agent is the time its runs spent working, read from the agent states.
func TestAgentUseCountsTheTimeAnAgentWorks(t *testing.T) {
	t.Parallel()
	h, tracker := makeUseHarness(t)
	h.out("b1", cmdMark("claude"))
	h.out("b2", cmdMark("codex"))
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	tracker.tick()
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	sum := tracker.summary()
	if got := sum.Agents["claude"]; got.WorkMs != 40_000 || got.Sessions != 1 {
		t.Errorf("claude: %+v, want 40 s and one session", got)
	}
	if got := sum.Agents["codex"]; got.WorkMs != 0 || got.Sessions != 1 {
		t.Errorf("codex, started and idle: %+v, want no time and one session", got)
	}
}

// An agent that exited keeps its last state until the next command: it works no more.
func TestAgentUseIgnoresAnAgentThatEnded(t *testing.T) {
	t.Parallel()
	h, tracker := makeUseHarness(t)
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	tracker.tick()
	h.states.records["b1"].running = false
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	if got := tracker.summary().Agents["claude"]; got.WorkMs != 0 {
		t.Errorf("an agent whose command ended earned %d ms", got.WorkMs)
	}
}

// A lead agent whose background sub-agents work is working, even while its own session waits for them.
func TestAgentUseCountsTheSubAgentsOfALeadAsWork(t *testing.T) {
	t.Parallel()
	h, tracker := makeUseHarness(t)
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateIdle, "claude"); err != nil {
		t.Fatal(err)
	}
	h.states.records["b1"].subagents = map[string]bool{"sub-1": true}
	tracker.tick()
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	if got := tracker.summary().Agents["claude"].WorkMs; got != 20_000 {
		t.Errorf("working time %d ms, want 20000", got)
	}
}

// Claude Code through another provider spends none of the Anthropic plan: it is no use of it.
func TestAgentUseLeavesOutARunOnAnotherProvider(t *testing.T) {
	t.Parallel()
	h, tracker := makeUseHarness(t)
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.states.records["b1"].settings.Provider = "gateway.example"
	tracker.tick()
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	if got, ok := tracker.summary().Agents["claude"]; ok {
		t.Errorf("a run on another provider counted: %+v", got)
	}
}

func TestAgentUseIsWrittenAtMostOnceAMinuteAndRestored(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "agentuse")
	h, tracker := makeUseHarness(t)
	tracker.store = agentuse.MakeStore(dir)
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.clock = h.clock.Add(time.Hour)
	tracker.tick()
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	first, err := tracker.store.Load()
	if err != nil || len(first.Agents) == 0 {
		t.Fatalf("nothing written after the first tick: %+v, %v", first, err)
	}
	h.clock = h.clock.Add(20 * time.Second)
	tracker.tick()
	again, _ := tracker.store.Load()
	if again.Agents["claude"] == nil || sumWork(first) != sumWork(again) {
		t.Errorf("the record was written again within a minute: %d then %d ms", sumWork(first), sumWork(again))
	}
	h.clock = h.clock.Add(time.Minute)
	tracker.tick()
	later, _ := tracker.store.Load()
	if sumWork(later) <= sumWork(first) {
		t.Errorf("the record was not written after a minute: %d ms", sumWork(later))
	}

	reborn := makeAgentUseTracker(h.states, tracker.store)
	reborn.now = tracker.now
	reborn.load()
	if got := reborn.summary().Agents["claude"]; got.WorkMs != sumWork(later) {
		t.Errorf("after a restart: %d ms, want %d", got.WorkMs, sumWork(later))
	}
}

func sumWork(file agentuse.File) int64 {
	var total int64
	for _, hours := range file.Agents {
		for _, b := range hours {
			total += b.WorkMs
		}
	}
	return total
}

// The use names every terminal's agent: only the windows read it.
func TestAgentUseRouteAnswersWindowsOnly(t *testing.T) {
	t.Parallel()
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, agentRoute)
	if err != nil {
		t.Fatal(err)
	}
	routetest.MustRefuse(t, link, append([]routetest.From{e.Terminal()}, e.Forged()...), molten.AgentUseCommand, nil)
	if _, errStr := routetest.Ask(t, link, e.Window(), molten.AgentUseCommand, nil); errStr != "" {
		t.Errorf("the use for a window: %s", errStr)
	}
}
