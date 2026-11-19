// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2397: which sub-agents run, from their own files. Synthetic session folders only.

const settleSessionId = "5e771e00-0000-4000-8000-000000002397"

var settleBase = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

type settleFixture struct {
	t       *testing.T
	session string
	subs    string
}

func makeSettleFixture(t *testing.T) settleFixture {
	t.Helper()
	root := t.TempDir()
	session := filepath.Join(root, "-work-demo", settleSessionId+".jsonl")
	subs := filepath.Join(filepath.Dir(session), settleSessionId, "subagents")
	if err := os.MkdirAll(subs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(session, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return settleFixture{t: t, session: session, subs: subs}
}

// agent writes a sub-agent's meta file (written at metaAt) and its transcript (last written at wroteAt; none when
// zero), as Claude Code lays them out.
func (f settleFixture) agent(agentId string, callId string, description string, finished bool, metaAt time.Time, wroteAt time.Time) {
	f.t.Helper()
	meta := map[string]any{
		"agentType": "sf-fix", "worktreePath": "/work/demo/.claude/worktrees/agent-" + agentId,
		"worktreeBranch": "worktree-agent-" + agentId, "description": description, "toolUseId": callId,
		"spawnDepth": 1, "requestShape": "background",
	}
	if finished {
		meta["finished"] = true
	}
	data, err := json.Marshal(meta)
	if err != nil {
		f.t.Fatal(err)
	}
	metaPath := filepath.Join(f.subs, "agent-"+agentId+".meta.json")
	if err := os.WriteFile(metaPath, data, 0o600); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chtimes(metaPath, metaAt, metaAt); err != nil {
		f.t.Fatal(err)
	}
	if wroteAt.IsZero() {
		return
	}
	transcript := filepath.Join(f.subs, "agent-"+agentId+".jsonl")
	line := `{"type":"assistant","isSidechain":true,"agentId":"` + agentId + `","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"working"}]}}` + "\n"
	if err := os.WriteFile(transcript, []byte(line), 0o600); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chtimes(transcript, wroteAt, wroteAt); err != nil {
		f.t.Fatal(err)
	}
}

func at(d time.Duration) time.Time {
	return settleBase.Add(d)
}

func stamp(d time.Duration) string {
	return at(d).Format("2006-01-02T15:04:05.000Z")
}

// startLines are a lead's records that start a background agent: its Agent call and the call's async result.
func startLines(callId string, agentId string, description string, when time.Duration) []string {
	return []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + callId + `","name":"Agent","input":{"description":"` + description + `","subagent_type":"sf-fix","run_in_background":true}}]},"sessionId":"s","timestamp":"` + stamp(when) + `"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + callId + `","content":"Async agent launched successfully."}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"` + agentId + `"},"sessionId":"s","timestamp":"` + stamp(when+time.Second) + `"}`,
	}
}

func settle(a *ClaudeAdapter, s *Session, session string, now time.Time) {
	lastWrite := func(agentId string) int64 { return a.SubagentWritten(session, agentId) }
	s.SettleSubagentFiles(readSubagentFiles(a, session, s.settledAgentIds()), now.UnixMilli())
	s.ReviveSubagents(now.UnixMilli(), lastWrite)
	s.QuietSubagents(now.UnixMilli(), lastWrite)
}

func settledSubagent(t *testing.T, s *Session, description string) SubagentInfo {
	t.Helper()
	for _, sa := range s.Subagents() {
		if sa.Description == description {
			return sa
		}
	}
	t.Fatalf("no sub-agent %q in %+v", description, s.Subagents())
	return SubagentInfo{}
}

// A lead stops with TaskStop an agent Claude Code said was "waiting on its own background work": the parent's
// transcript never tells that end, its meta file does. It leaves the running ones at once, not 30 minutes later as
// a quiet one.
func TestSettleFinishedSubagentLeavesRunning(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	lines := startLines("toolu_stop", "a5e7000000000stop", "#9101 stopped job", 0)
	lines = append(lines,
		`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a5e7000000000stop</task-id>\n<tool-use-id>toolu_stop</tool-use-id>\n<status>completed</status>\n<summary>Agent \"#9101 stopped job\" is waiting on its own background work</summary>\n</task-notification>"},"sessionId":"s","timestamp":"`+stamp(20*time.Minute)+`"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_taskstop","name":"TaskStop","input":{"task_id":"a5e7000000000stop"}}]},"sessionId":"s","timestamp":"`+stamp(21*time.Minute)+`"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_taskstop","content":"stopped"}]},"toolUseResult":{"message":"Successfully stopped task","task_id":"a5e7000000000stop","task_type":"local_agent"},"sessionId":"s","timestamp":"`+stamp(21*time.Minute+time.Second)+`"}`,
	)
	parseLines(t, a, s, lines...)
	if sa := settledSubagent(t, s, "#9101 stopped job"); sa.State != SubagentRunning {
		t.Fatalf("the waiting notification keeps the agent running until its files say otherwise: %+v", sa)
	}
	f.agent("a5e7000000000stop", "toolu_stop", "#9101 stopped job", true, at(21*time.Minute), at(21*time.Minute))
	settle(a, s, f.session, at(22*time.Minute))
	sa := settledSubagent(t, s, "#9101 stopped job")
	if sa.State != SubagentDone || sa.Ended != at(21*time.Minute).UnixMilli() {
		t.Fatalf("its meta file's finished ends it, at the meta's write: %+v", sa)
	}
	if running := s.runningSubagents(); len(running) != 0 {
		t.Errorf("a finished sub-agent is not running: %+v", running)
	}
}

// A sub-agent SendMessage resumed after its end runs again: Claude Code rewrites its meta file without finished, and
// its transcript is written again. A meta file that still says finished does not end it while its transcript is
// written well after it.
func TestSettleResumedSubagentRunsAgain(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	lines := startLines("toolu_resume", "a5e70000000resume", "#9102 resumed job", 0)
	lines = append(lines,
		`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a5e70000000resume</task-id>\n<tool-use-id>toolu_resume</tool-use-id>\n<status>completed</status>\n</task-notification>"},"sessionId":"s","timestamp":"`+stamp(30*time.Minute)+`"}`,
	)
	parseLines(t, a, s, lines...)
	f.agent("a5e70000000resume", "toolu_resume", "#9102 resumed job", true, at(30*time.Minute), at(30*time.Minute))
	settle(a, s, f.session, at(31*time.Minute))
	if sa := settledSubagent(t, s, "#9102 resumed job"); sa.State != SubagentDone {
		t.Fatalf("ended by its notification and its meta: %+v", sa)
	}

	// SendMessage resumes it; the parent writes only a queued message, which carries no resume.
	f.agent("a5e70000000resume", "toolu_resume", "#9102 resumed job", false, at(40*time.Minute), at(45*time.Minute))
	settle(a, s, f.session, at(46*time.Minute))
	if sa := settledSubagent(t, s, "#9102 resumed job"); sa.State != SubagentRunning {
		t.Fatalf("a resumed sub-agent whose transcript is written again runs: %+v", sa)
	}

	f.agent("a5e70000000resume", "toolu_resume", "#9102 resumed job", true, at(40*time.Minute), at(45*time.Minute))
	ids := a.ListSubagents(f.session)
	if len(ids) != 1 || ids[0].Finished {
		t.Errorf("a transcript written well after a finished meta is a running agent: %+v", ids)
	}
	ids = ApplyHookSubagents(ids, nil, at(46*time.Minute))
	if ids[0].State != SubagentRunning {
		t.Errorf("Integration reads it as running too: %+v", ids[0])
	}
}

// After the lead's conversation is compacted, or when its Agent call lies before the part of a long transcript the
// companion reads, the parent's records never start the agent: its own files list it while it runs. A finished one,
// or one silent for long, is not added.
func TestSettleAddsRunningSubagentTheTranscriptNeverStarted(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	parseLines(t, a, s,
		`{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation."},"sessionId":"s","timestamp":"`+stamp(50*time.Minute)+`"}`,
	)
	f.agent("a5e70000000000new", "toolu_before", "#9103 started before the compaction", false, at(0), at(59*time.Minute))
	f.agent("a5e700000000ended", "toolu_ended", "#9104 finished", true, at(40*time.Minute), at(40*time.Minute))
	f.agent("a5e700000000quiet", "toolu_quiet", "#9105 silent", false, at(0), at(5*time.Minute))
	settle(a, s, f.session, at(time.Hour))
	subs := s.Subagents()
	if len(subs) != 1 {
		t.Fatalf("only the running agent is added: %+v", subs)
	}
	sa := subs[0]
	if sa.State != SubagentRunning || !sa.Background || sa.Description != "#9103 started before the compaction" || sa.Kind != "sf-fix" {
		t.Fatalf("the running agent comes from its meta file: %+v", sa)
	}
	if running := s.runningSubagents(); len(running) != 1 || running[0].agentId != "a5e70000000000new" {
		t.Errorf("it counts among the running ones, with its agent id: %+v", running)
	}

	f.agent("a5e70000000000new", "toolu_before", "#9103 started before the compaction", true, at(70*time.Minute), at(70*time.Minute))
	settle(a, s, f.session, at(71*time.Minute))
	if sa := s.Subagents()[0]; sa.State != SubagentDone {
		t.Errorf("its end in its meta file ends it: %+v", sa)
	}
}

// The agent the transcript started, whose async result named no agent id, is matched to its files by its call.
func TestSettleMatchesByCall(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	s := MakeSession()
	parseLines(t, a, s,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_noid","name":"Agent","input":{"description":"#9106 no id","run_in_background":true}}]},"sessionId":"s","timestamp":"`+stamp(0)+`"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_noid","content":"launched"}]},"toolUseResult":{"status":"async_launched"},"sessionId":"s","timestamp":"`+stamp(time.Second)+`"}`,
	)
	f.agent("a5e7000000000noid", "toolu_noid", "#9106 no id", true, at(10*time.Minute), at(10*time.Minute))
	settle(a, s, f.session, at(11*time.Minute))
	subs := s.Subagents()
	if len(subs) != 1 || subs[0].State != SubagentDone {
		t.Fatalf("one agent, ended by its files, not listed twice: %+v", subs)
	}
}

// A SubagentStop hook ends an agent only when its transcript was not written well after it: an agent stops its turn
// and goes on (its own background work, a SendMessage resume) without a new SubagentStart. Codex shares the rule (#987).
func TestHookStopFollowedByWritesKeepsRunning(t *testing.T) {
	now := at(time.Hour)
	stop := at(20 * time.Minute).UnixMilli()
	for _, agent := range []string{molten.AgentIdClaude, molten.AgentIdCodex} {
		ids := []SubagentIdentity{
			{AgentId: "goes-on", LastWrite: at(55 * time.Minute).UnixMilli()},
			{AgentId: "ended", LastWrite: at(20*time.Minute + 10*time.Second).UnixMilli()},
		}
		hook := func(agentId string, event string, when int64) SubagentHookEvent {
			return SubagentHookEvent{AgentSubagentRequest: molten.AgentSubagentRequest{Agent: agent, AgentId: agentId, Event: event}, At: when}
		}
		hooks := []SubagentHookEvent{
			hook("goes-on", molten.SubagentEventStart, at(0).UnixMilli()),
			hook("goes-on", molten.SubagentEventStop, stop),
			hook("ended", molten.SubagentEventStart, at(0).UnixMilli()),
			hook("ended", molten.SubagentEventStop, stop),
		}
		got := ApplyHookSubagents(ids, hooks, now)
		if got[0].State != SubagentRunning || got[0].Finished {
			t.Errorf("%s: an agent that writes after its stop runs: %+v", agent, got[0])
		}
		if got[1].State != SubagentDone || got[1].LastWrite != stop {
			t.Errorf("%s: an agent silent after its stop ended at the stop: %+v", agent, got[1])
		}
	}
}

// Hundreds of sub-agents in one lead session: the recently written ones are listed and their calls known, whatever
// their file names; the meta files read stay capped.
func TestRecentSubagentListedPastTheCap(t *testing.T) {
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	for i := 0; i < claudeMaxSubagentMetas+5; i++ {
		f.agent(fmt.Sprintf("a0old%012d", i), fmt.Sprintf("toolu_old_%d", i), fmt.Sprintf("old job %d", i), true, at(0), at(time.Duration(i)*time.Second))
	}
	f.agent("zzzrecent0000001", "toolu_recent", "#9107 recent", false, at(time.Hour), at(2*time.Hour))
	ids := a.ListSubagents(f.session)
	if len(ids) != maxIdentitySubagents || ids[0].AgentId != "zzzrecent0000001" || ids[0].CallId != "toolu_recent" {
		t.Fatalf("the most recently written agent comes first: %d listed, first %+v", len(ids), ids[0])
	}
	if got := a.SubagentIds(f.session)["toolu_recent"]; got != "zzzrecent0000001" {
		t.Errorf("its call is known: %q", got)
	}
}
