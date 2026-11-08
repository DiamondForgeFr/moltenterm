// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"fmt"
	"testing"
	"time"
)

func waitingLaunch(id string, agentId string, kind string, description string, stamp string) []string {
	return []string{
		fmt.Sprintf(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":%q,"name":"Agent","input":{"subagent_type":%q,"description":%q,"run_in_background":true}}]},"sessionId":"s","timestamp":%q}`, id, kind, description, stamp),
		fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":%q,"content":"Async agent launched successfully."}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":%q},"sessionId":"s","timestamp":%q}`, id, agentId, stamp),
	}
}

// What Claude Code writes when an agent's turn ends while a monitor or a background command of its own still runs:
// status completed, yet the agent is alive and resumes on its own.
func waitingNotification(agentId string, toolUseId string, description string, stamp string) string {
	toolUse := ""
	if toolUseId != "" {
		toolUse = `<tool-use-id>` + toolUseId + `</tool-use-id>\n`
	}
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>%s</task-id>\n%s<status>completed</status>\n<summary>Agent \"%s\" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>The monitor is armed.</result>\n</task-notification>"},"sessionId":"s","timestamp":%q}`, agentId, toolUse, description, stamp)
}

func finishedNotification(agentId string, description string, stamp string) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>%s</task-id>\n<status>completed</status>\n<summary>Agent \"%s\" finished</summary>\n</task-notification>"},"sessionId":"s","timestamp":%q}`, agentId, description, stamp)
}

// #2014: an agent whose turn ended while its own background work runs still runs; its "finished" notification, later,
// ends it, and the records it writes as it ends do not run it again.
func TestSubagentWaitingOnItsBackgroundWorkStillRuns(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	const agentId = "a9c1d209a68ee64f9"
	lines := waitingLaunch("toolu_1999", agentId, "sf-build", "#1999 Brokk step B", "2026-11-06T16:00:00.000Z")
	lines = append(lines, waitingNotification(agentId, "toolu_1999", "#1999 Brokk step B", "2026-11-06T16:34:26.291Z"))
	parseLines(t, a, s, lines...)
	if sub := s.Subagents()[0]; sub.State != SubagentRunning || sub.Ended != 0 {
		t.Fatalf("an agent waiting on its own background work runs: %+v", sub)
	}
	if len(s.runningSubagents()) != 1 {
		t.Fatalf("it counts among the running ones: %+v", s.Subagents())
	}

	parseLines(t, a, s,
		waitingNotification(agentId, "", "#1999 Brokk step B", "2026-11-06T16:43:20.078Z"),
		finishedNotification(agentId, "#1999 Brokk step B", "2026-11-06T16:50:44.062Z"),
	)
	sub := s.Subagents()[0]
	if sub.State != SubagentDone || sub.Ended == 0 {
		t.Fatalf("its finished notification ends it: %+v", sub)
	}
	finished := time.Date(2026, 11, 6, 16, 50, 44, 62_000_000, time.UTC).UnixMilli()
	if sub.Ended != finished {
		t.Errorf("it ended when its finished notification came: %d, want %d", sub.Ended, finished)
	}
	lastWrite := func(string) int64 { return finished + 2_000 }
	if s.ReviveSubagents(finished+10_000, lastWrite) || s.Subagents()[0].State != SubagentDone {
		t.Fatalf("the records it writes as it finishes leave it ended: %+v", s.Subagents()[0])
	}
	if len(s.runningSubagents()) != 0 {
		t.Fatalf("an ended sub-agent leaves the running ones: %+v", s.Subagents())
	}
}

// A repeated end moves the end to the last one: a Codex agent's completed activity after a stop counts from then.
func TestSubagentRepeatedEndKeepsLatestTime(t *testing.T) {
	s := MakeSession()
	s.StartSubagent("call", "Audit", "worker", "", "", true, 1_000)
	s.SetRecordTime(10_000)
	s.EndSubagent("call", "completed")
	s.SetRecordTime(90_000)
	s.EndSubagent("call", "completed")
	if sub := s.Subagents()[0]; sub.Ended != 90_000 {
		t.Fatalf("the last end counts: %+v", sub)
	}
}

// #2014: every running sub-agent is listed, the fifth one and the sf-edit one included, even when one of them reported
// a turn that ended on its own background work.
func TestFiveRunningSubagentsAllListed(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	agents := []struct{ call, agentId, kind, description string }{
		{"toolu_2003", "a0000000000002003", "sf-build", "#2003 Brokk panel"},
		{"toolu_2008", "a0000000000002008", "sf-build", "#2008 agent note in sidebar"},
		{"toolu_2007", "ad4dbff87216331b5", "sf-edit", "#2007 character v0.3.1 + blink measure"},
		{"toolu_2011", "a0000000000002011", "sf-terminal", "#2011 affected-test selection in CI"},
		{"toolu_2014", "a0000000000002014", "sf-fix", "#2014 stale sub-agents in sidebar"},
	}
	var lines []string
	for i, ag := range agents {
		lines = append(lines, waitingLaunch(ag.call, ag.agentId, ag.kind, ag.description, fmt.Sprintf("2026-11-06T17:%02d:00.000Z", i))...)
	}
	lines = append(lines, waitingNotification("ad4dbff87216331b5", "toolu_2007", "#2007 character v0.3.1 + blink measure", "2026-11-06T17:18:55.713Z"))
	parseLines(t, a, s, lines...)
	running := s.runningSubagents()
	if len(running) != len(agents) {
		t.Fatalf("all %d running sub-agents are listed as running, got %d: %+v", len(agents), len(running), s.Subagents())
	}
	edit := false
	for _, sub := range s.Subagents() {
		if sub.Kind == "sf-edit" && sub.State == SubagentRunning {
			edit = true
		}
	}
	if !edit {
		t.Errorf("the sf-edit agent is listed as running: %+v", s.Subagents())
	}
}

// A new sub-agent is kept when the list is full of running ones, never dropped as it is added.
func TestNewSubagentKeptWhenListFull(t *testing.T) {
	s := MakeSession()
	for i := 0; i < MaxSubagents; i++ {
		s.StartSubagent(fmt.Sprintf("call-%d", i), fmt.Sprintf("Job %d", i), "sf-build", "", "", true, int64(i+1))
	}
	s.StartSubagent("call-new", "New job", "sf-edit", "", "", true, 1_000)
	found := false
	for _, sub := range s.Subagents() {
		if sub.Id == "call-new" && sub.State == SubagentRunning {
			found = true
		}
	}
	if !found {
		t.Fatalf("the new running sub-agent is listed: %d listed", len(s.Subagents()))
	}
}
