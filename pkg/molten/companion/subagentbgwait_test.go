// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path/filepath"
	"testing"
	"time"
)

// #2498: an agent whose turn ended while its own background work (a test run, a monitor) runs on. Claude Code
// notifies the lead that it "is waiting on its own background work" and marks its meta file finished as that turn
// ends; the agent writes nothing until its work reports, often for longer than SubagentQuietAfter.

const bgWaitAgent = "a2498000000000bgw"

func bgWaitStart(t *testing.T, f settleFixture, a *ClaudeAdapter, s *Session) time.Time {
	t.Helper()
	lines := startLines("toolu_bgwait", bgWaitAgent, "#9201 test sweep", 0)
	lines = append(lines, waitingNotification(bgWaitAgent, "toolu_bgwait", "#9201 test sweep", stamp(20*time.Minute)))
	parseLines(t, a, s, lines...)
	// In the session of 2026-11-23 the meta was written 3 s after the waiting notification.
	ended := at(20*time.Minute + 3*time.Second)
	f.agent(bgWaitAgent, "toolu_bgwait", "#9201 test sweep", true, ended, ended.Add(-10*time.Second))
	return ended
}

func TestSubagentWaitingOnBackgroundWorkStaysRunningDespiteFinishedMeta(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	bgWaitStart(t, f, a, s)
	for _, now := range []time.Duration{21 * time.Minute, 45 * time.Minute, 90 * time.Minute} {
		settle(a, s, f.session, at(now))
		if sa := settledSubagent(t, s, "#9201 test sweep"); sa.State != SubagentRunning || sa.Ended != 0 {
			t.Fatalf("at +%s an agent waiting on its own background work runs, whatever its meta says: %+v", now, sa)
		}
		if running := s.runningSubagents(); len(running) != 1 || running[0].agentId != bgWaitAgent {
			t.Fatalf("at +%s it counts among the running ones (Agents at work, milestone tickets): %+v", now, running)
		}
	}
	settle(a, s, f.session, at(20*time.Minute).Add(SubagentWaitingQuietAfter+time.Minute))
	if sa := settledSubagent(t, s, "#9201 test sweep"); sa.State != SubagentQuiet {
		t.Errorf("silent for longer than SubagentWaitingQuietAfter it is quiet: %+v", sa)
	}
}

func TestSubagentWaitingOnBackgroundWorkEndsWithItsFinishedNotification(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	bgWaitStart(t, f, a, s)
	settle(a, s, f.session, at(25*time.Minute))
	parseLines(t, a, s, finishedNotification(bgWaitAgent, "#9201 test sweep", stamp(50*time.Minute)))
	finished := at(50 * time.Minute)
	f.agent(bgWaitAgent, "toolu_bgwait", "#9201 test sweep", true, finished, finished.Add(-time.Second))
	settle(a, s, f.session, at(51*time.Minute))
	sa := settledSubagent(t, s, "#9201 test sweep")
	if sa.State != SubagentDone || sa.Ended != finished.UnixMilli() {
		t.Fatalf("its finished notification ends it, when it came: %+v", sa)
	}
	if running := s.runningSubagents(); len(running) != 0 {
		t.Errorf("a finished agent is not running: %+v", running)
	}
}

func TestSubagentWaitingOnBackgroundWorkEndsWithTaskStop(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	ended := bgWaitStart(t, f, a, s)
	settle(a, s, f.session, at(25*time.Minute))
	parseLines(t, a, s,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_nothing","name":"TaskStop","input":{"task_id":"`+bgWaitAgent+`"}}]},"sessionId":"s","timestamp":"`+stamp(29*time.Minute)+`"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"<tool_use_error>Task `+bgWaitAgent+` is not running (status: completed)</tool_use_error>","is_error":true,"tool_use_id":"toolu_nothing"}]},"toolUseResult":"Error: Task `+bgWaitAgent+` is not running (status: completed)","sessionId":"s","timestamp":"`+stamp(29*time.Minute)+`"}`,
	)
	settle(a, s, f.session, at(29*time.Minute+time.Second))
	if sa := settledSubagent(t, s, "#9201 test sweep"); sa.State != SubagentRunning {
		t.Fatalf("a TaskStop that stopped nothing leaves it running: %+v", sa)
	}
	parseLines(t, a, s,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_taskstop","name":"TaskStop","input":{"task_id":"`+bgWaitAgent+`"}}]},"sessionId":"s","timestamp":"`+stamp(30*time.Minute)+`"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_taskstop","content":"stopped"}]},"toolUseResult":{"message":"Successfully stopped task: `+bgWaitAgent+` (#9201 test sweep)","task_id":"`+bgWaitAgent+`","task_type":"local_agent","command":"#9201 test sweep"},"sessionId":"s","timestamp":"`+stamp(30*time.Minute+time.Second)+`"}`,
	)
	settle(a, s, f.session, at(31*time.Minute))
	sa := settledSubagent(t, s, "#9201 test sweep")
	if sa.State != SubagentDone || sa.Ended != ended.UnixMilli() {
		t.Fatalf("after TaskStop its finished meta ends it, at the meta's write: %+v", sa)
	}
	if running := s.runningSubagents(); len(running) != 0 {
		t.Errorf("a stopped agent is not running: %+v", running)
	}
}

// A later start of the same call (an agent a new Agent call reuses) forgets the wait.
func TestSubagentRestartForgetsWaiting(t *testing.T) {
	t.Parallel()
	s := MakeSession()
	s.StartSubagent("call", "Sweep", "sf-build", "", "", true, 1_000)
	s.SetSubagentId("call", "agent")
	s.EndSubagent("agent", notificationWaitingStatus)
	s.StartSubagent("call", "Sweep", "sf-build", "", "", true, 2_000)
	if s.subagent("call").waiting {
		t.Fatalf("a new start is not waiting")
	}
}
