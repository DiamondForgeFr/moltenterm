// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2468: one row per sub-agent, whichever source saw it first. A lead that launches two background agents in one
// message gets each agent's meta file at once, while Claude Code writes the later calls of that message into the
// parent's transcript only after the first call's result. Synthetic session folders only.

func parallelLaunchLines() (first []string, second []string) {
	first = startLines("toolu_par_one", "a2468000000000one", "#9201 overlap bug", 0)
	second = startLines("toolu_par_two", "a2468000000000two", "#9202 arranging", 9*time.Second)
	return first, second
}

func assertOneRowEach(t *testing.T, s *Session, descriptions ...string) {
	t.Helper()
	subs := s.Subagents()
	if len(subs) != len(descriptions) {
		t.Fatalf("one row per agent, %d expected: %+v", len(descriptions), subs)
	}
	for _, d := range descriptions {
		sa := settledSubagent(t, s, d)
		if sa.Started <= 0 || sa.State != SubagentRunning || !sa.Background {
			t.Errorf("%q has its call's start (its duration) and runs: %+v", d, sa)
		}
	}
}

// The companion's sweep reads the meta files while the parent's transcript does not yet hold the calls: the calls
// found next land on the rows the files added.
func TestParallelLaunchesSettledBeforeTheirCalls(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	f.agent("a2468000000000one", "toolu_par_one", "#9201 overlap bug", false, at(time.Second), at(5*time.Second))
	f.agent("a2468000000000two", "toolu_par_two", "#9202 arranging", false, at(time.Second), at(5*time.Second))
	settle(a, s, f.session, at(6*time.Second))
	if subs := s.Subagents(); len(subs) != 2 {
		t.Fatalf("the files list both running agents: %+v", subs)
	}

	first, second := parallelLaunchLines()
	parseLines(t, a, s, first...)
	settle(a, s, f.session, at(12*time.Second))
	parseLines(t, a, s, second...)
	settle(a, s, f.session, at(20*time.Second))
	assertOneRowEach(t, s, "#9201 overlap bug", "#9202 arranging")
	if running := s.runningSubagents(); len(running) != 2 {
		t.Errorf("both count among the running ones: %+v", running)
	}
	if sa := settledSubagent(t, s, "#9201 overlap bug"); sa.Id != "toolu_par_one" || sa.Model != "claude-opus-5-5" {
		t.Errorf("the row is the call's and keeps the model its files gave: %+v", sa)
	}
}

// The sweep runs between the first call's result and the second call: the second agent's files add a row the second
// call then takes.
func TestParallelLaunchesSettledBetweenTheirCalls(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	first, second := parallelLaunchLines()
	parseLines(t, a, s, first...)
	f.agent("a2468000000000one", "toolu_par_one", "#9201 overlap bug", false, at(time.Second), at(5*time.Second))
	f.agent("a2468000000000two", "toolu_par_two", "#9202 arranging", false, at(time.Second), at(5*time.Second))
	settle(a, s, f.session, at(6*time.Second))
	parseLines(t, a, s, second...)
	settle(a, s, f.session, at(20*time.Second))
	assertOneRowEach(t, s, "#9201 overlap bug", "#9202 arranging")
}

// Meta files that do not name their call: the call's result gives the agent id, and the files' row folds into the
// call's row.
func TestFilesWithoutCallFoldIntoTheCallRow(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	f.agent("a2468000000000one", "", "#9201 overlap bug", false, at(time.Second), at(5*time.Second))
	settle(a, s, f.session, at(6*time.Second))
	first, _ := parallelLaunchLines()
	parseLines(t, a, s, first...)
	assertOneRowEach(t, s, "#9201 overlap bug")
	if sa := s.Subagents()[0]; sa.Id != "toolu_par_one" {
		t.Errorf("the call's row is kept: %+v", sa)
	}

	// A running call whose result named no agent yet is matched by its description.
	s = MakeSession()
	parseLines(t, a, s, first[0])
	settle(a, s, f.session, at(6*time.Second))
	assertOneRowEach(t, s, "#9201 overlap bug")
	if running := s.runningSubagents(); len(running) != 1 || running[0].agentId != "a2468000000000one" {
		t.Errorf("the call's row takes the files' agent id: %+v", running)
	}
}

// The hook, the transcript and the meta file all report the same agent: one row in the companion, one agent for
// Integration.
func TestHookTranscriptAndFilesReportOneAgent(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	f.agent("a2468000000000one", "toolu_par_one", "#9201 overlap bug", false, at(time.Second), at(5*time.Second))
	settle(a, s, f.session, at(6*time.Second))
	first, _ := parallelLaunchLines()
	parseLines(t, a, s, first...)
	settle(a, s, f.session, at(10*time.Second))
	assertOneRowEach(t, s, "#9201 overlap bug")

	hooks := []SubagentHookEvent{{
		AgentSubagentRequest: molten.AgentSubagentRequest{
			Agent: molten.AgentIdClaude, AgentId: "a2468000000000one", Event: molten.SubagentEventStart,
			TranscriptPath: filepath.Join(f.subs, "agent-a2468000000000one.jsonl"),
		},
		At: at(time.Second).UnixMilli(),
	}}
	ids := ApplyHookSubagents(a.ListSubagents(f.session), hooks, at(10*time.Second))
	if len(ids) != 1 || ids[0].AgentId != "a2468000000000one" || ids[0].State != SubagentRunning {
		t.Errorf("one running agent: %+v", ids)
	}
}
