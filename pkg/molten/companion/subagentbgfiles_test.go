// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2498: what every reader of the sub-agents' own files sees (Integration, the activity gauge and popover, the milestone
// block), with no parent transcript at hand: a finished meta whose agent waits on its own background work runs.

func bgLaunchLine(taskId string) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg","content":"Command running in background with ID: ` + taskId + `"}]},"toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"` + taskId + `"}}`
}

func monitorLaunchLine(taskId string) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_mon","content":"Monitor started"}]},"toolUseResult":{"taskId":"` + taskId + `","timeoutMs":900000,"persistent":false}}`
}

func bgEndLine(taskId string) string {
	return `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>` + taskId + `</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>"}}`
}

const bgTurnEndLine = `{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"The runs go on in the background. I'll wait for their notifications."}]}}`

func TestClaudeBackgroundPending(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		lines []string
		want  bool
	}{
		{"nothing in the background", []string{bgTurnEndLine}, false},
		{"a background command runs", []string{bgLaunchLine("b1"), bgTurnEndLine}, true},
		{"a monitor runs", []string{monitorLaunchLine("m1"), bgTurnEndLine}, true},
		{"its end came", []string{bgLaunchLine("b1"), bgEndLine("b1"), bgTurnEndLine}, false},
		{"one of two ended", []string{bgLaunchLine("b1"), monitorLaunchLine("m1"), bgEndLine("b1"), bgTurnEndLine}, true},
		{"stopped by the agent", []string{bgLaunchLine("b1"), `{"type":"user","toolUseResult":{"message":"Successfully stopped task: b1 (go test)","task_id":"b1","task_type":"local_bash"}}`}, false},
		{"an end whose start lies before the tail", []string{bgEndLine("b0"), bgTurnEndLine}, false},
	}
	for _, tc := range cases {
		if got := claudeBackgroundPending([]byte(strings.Join(tc.lines, "\n") + "\n")); got != tc.want {
			t.Errorf("%s: pending %v, want %v", tc.name, got, tc.want)
		}
	}
}

func writeSubagentTranscript(t *testing.T, f settleFixture, agentId string, when time.Time, lines ...string) {
	t.Helper()
	path := filepath.Join(f.subs, "agent-"+agentId+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func TestFilesListSubagentWaitingOnBackgroundWorkAsRunning(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	const agentId = "a2498000000files"
	ended := time.Now().Add(-25 * time.Minute)
	f.agent(agentId, "toolu_files", "#9202 test sweep", true, ended.Add(2*time.Second), time.Time{})
	writeSubagentTranscript(t, f, agentId, ended, `{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"start"}]}}`, bgLaunchLine("bfiles"), bgTurnEndLine)
	// The SubagentStop of the turn that ended on the background work.
	hooks := []SubagentHookEvent{{AgentSubagentRequest: molten.AgentSubagentRequest{Agent: molten.AgentIdClaude, AgentId: agentId, Event: molten.SubagentEventStop}, At: ended.UnixMilli()}}
	ids := ApplyHookSubagents(a.ListSubagents(f.session), hooks, time.Now())
	if len(ids) != 1 || ids[0].Finished || ids[0].State != SubagentRunning || !ids[0].Waiting {
		t.Fatalf("a finished meta whose agent waits on its background work runs, 25 min into the wait: %+v", ids)
	}
	if id, ok := a.SubagentFile(f.session, agentId); !ok || id.Finished {
		t.Errorf("the settle's read of the agent's files agrees: %+v", id)
	}

	writeSubagentTranscript(t, f, agentId, ended.Add(time.Minute), `{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"start"}]}}`, bgLaunchLine("bfiles"), bgTurnEndLine, bgEndLine("bfiles"), `{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Done."}]}}`)
	f.agent(agentId, "toolu_files", "#9202 test sweep", true, ended.Add(time.Minute+time.Second), time.Time{})
	ids = ApplyHookSubagents(a.ListSubagents(f.session), nil, time.Now())
	if len(ids) != 1 || !ids[0].Finished || ids[0].State != SubagentDone {
		t.Fatalf("once its background work reported and its turn ended, it is done: %+v", ids)
	}
}

// Two agents of different providers in one terminal, one after the other (a Claude Code session, then Kimi Code), or
// in the same folder: a block's sub-agents are those of the agent that runs in it now, never an earlier run's.
func TestPaneSubagentsOnlyOfTheRunningAgent(t *testing.T) {
	t.Parallel()
	f := makeClaudeIdentityFixture(t)
	m := MakeManager()
	m.adapterFor = func(agent string) Adapter {
		switch agent {
		case molten.AgentIdClaude:
			return MakeClaudeAdapter([]string{f.root})
		case molten.AgentIdKimi:
			return MakeKimiAdapter([]string{t.TempDir()})
		}
		return nil
	}
	started := time.Now().Add(-45 * time.Minute)
	runs := map[string]molten.AgentRunInfo{
		"kimi-block":   {Agent: molten.AgentIdKimi, Running: true, Started: started.UnixMilli()},
		"claude-block": {Agent: molten.AgentIdClaude, Running: true, Started: started.UnixMilli()},
	}
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		run, ok := runs[blockId]
		return run, ok
	}
	claudeStop := func(blockId string, at time.Time) SubagentHookEvent {
		return SubagentHookEvent{AgentSubagentRequest: molten.AgentSubagentRequest{
			BlockId: blockId, Agent: molten.AgentIdClaude, Event: molten.SubagentEventStop, AgentId: "b56e",
			TranscriptPath: filepath.Join(f.subs, "agent-b56e.jsonl"),
		}, At: at.UnixMilli()}
	}
	kimiStart := SubagentHookEvent{AgentSubagentRequest: molten.AgentSubagentRequest{BlockId: "kimi-block", Agent: molten.AgentIdKimi, Event: molten.SubagentEventStart}, At: time.Now().UnixMilli()}

	// The Kimi terminal ran Claude Code before: its log still holds that run's reports.
	if got := m.PaneSubagents("kimi-block", []SubagentHookEvent{claudeStop("kimi-block", started.Add(-time.Hour)), kimiStart}); len(got) != 0 {
		t.Errorf("a Kimi Code agent lists none of a Claude Code session's sub-agents: %+v", got)
	}
	if got := m.PaneSubagents("kimi-block", []SubagentHookEvent{kimiStart, claudeStop("kimi-block", time.Now())}); len(got) != 0 {
		t.Errorf("a report of another agent never names the block's session: %+v", got)
	}
	if got := m.PaneSubagents("claude-block", []SubagentHookEvent{claudeStop("claude-block", started.Add(-time.Hour))}); len(got) != 0 {
		t.Errorf("a report from before the run's start is an earlier run's: %+v", got)
	}
	if got := m.PaneSubagents("claude-block", []SubagentHookEvent{claudeStop("claude-block", time.Now())}); len(got) != 2 {
		t.Errorf("the running Claude Code agent's own reports name its session: %+v", got)
	}
}
