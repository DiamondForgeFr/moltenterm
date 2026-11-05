// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const forkAgentId = "a1f0c0ffee0000001"

// #1941: a fork started in the background ends a first time, then SendMessage resumes it. The parent writes no new
// Agent call, only SendMessage's result; the resumed run's end names the SendMessage call and the agent as its task.
func TestClaudeForkResumedBySendMessage(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	parseFile(t, a, s, "claude-fork-resume.jsonl")
	subs := s.Subagents()
	if len(subs) != 1 {
		t.Fatalf("one fork, listed once: %+v", subs)
	}
	fork := subs[0]
	if fork.Kind != "fork" || fork.Description != "Mascot keyframes and review panel" || !fork.Background {
		t.Errorf("the fork keeps its call's description and kind: %+v", fork)
	}
	if fork.State != SubagentRunning || fork.Ended != 0 {
		t.Fatalf("a fork resumed by SendMessage after its first end runs: %+v", fork)
	}
	if running := s.runningSubagents(); len(running) != 1 {
		t.Errorf("the resumed fork counts among the running ones: %+v", running)
	}

	end := `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>` + forkAgentId + `</task-id>\n<tool-use-id>toolu_send_resume</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Mascot keyframes and review panel\" completed</summary>\n</task-notification>"},"uuid":"u6","sessionId":"ffff1111-2222-3333-4444-555555555555","timestamp":"2026-11-05T16:11:34.688Z"}`
	parseLines(t, a, s, end)
	if fork = s.Subagents()[0]; fork.State != SubagentDone || fork.Ended == 0 {
		t.Fatalf("the resumed run's end, named by its SendMessage call, ends the fork: %+v", fork)
	}
}

// A resumed run that fails fails the fork, by its task id too.
func TestClaudeResumedRunFails(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	parseFile(t, a, s, "claude-fork-resume.jsonl")
	end := `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>` + forkAgentId + `</task-id>\n<tool-use-id>toolu_send_resume</tool-use-id>\n<status>failed</status>\n</task-notification>"},"timestamp":"2026-11-05T16:11:34.688Z","sessionId":"s"}`
	parseLines(t, a, s, end)
	if fork := s.Subagents()[0]; fork.State != SubagentFailed {
		t.Fatalf("a resumed run that fails fails the fork: %+v", fork)
	}
}

// #1941: a message queued while the fork ran resumes it once it ended, and the parent's transcript tells nothing of
// it: the fork's own transcript, written again well after its end, runs it again. Its last records, written as it
// ends, do not.
func TestClaudeForkRunsAgainWhenItsTranscriptIsWritten(t *testing.T) {
	root := t.TempDir()
	session := filepath.Join(root, "-work-demo", "ffff1111-2222-3333-4444-555555555555.jsonl")
	subs := filepath.Join(filepath.Dir(session), "ffff1111-2222-3333-4444-555555555555", "subagents")
	if err := os.MkdirAll(subs, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(subs, "agent-"+forkAgentId+".jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"fork-context-ref","agentId":"`+forkAgentId+`"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := MakeClaudeAdapter([]string{root})
	s := MakeSession()
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fork","name":"Agent","input":{"subagent_type":"fork","description":"Mascot clips"}}]},"sessionId":"s","timestamp":"2026-11-05T15:00:00.000Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fork","content":"Async agent launched successfully."}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"` + forkAgentId + `"},"sessionId":"s","timestamp":"2026-11-05T15:00:01.000Z"}`,
		`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>` + forkAgentId + `</task-id>\n<tool-use-id>toolu_fork</tool-use-id>\n<status>completed</status>\n</task-notification>"},"sessionId":"s","timestamp":"2026-11-05T15:10:00.000Z"}`,
	}
	parseLines(t, a, s, lines...)
	ended := s.Subagents()[0].Ended
	if s.Subagents()[0].State != SubagentDone || ended == 0 {
		t.Fatalf("the notification ends the fork: %+v", s.Subagents()[0])
	}
	lastWrite := func(agentId string) int64 { return a.SubagentWritten(session, agentId) }

	setWritten(t, transcript, ended+2_000)
	if s.ReviveSubagents(ended+5_000, lastWrite) || s.Subagents()[0].State != SubagentDone {
		t.Fatalf("the records written as it ends do not run it again: %+v", s.Subagents()[0])
	}

	written := ended + 4*time.Minute.Milliseconds()
	setWritten(t, transcript, written)
	if !s.ReviveSubagents(written+1_000, lastWrite) {
		t.Fatal("a write well after its end changes the fork")
	}
	fork := s.Subagents()[0]
	if fork.State != SubagentRunning || fork.Ended != 0 || !fork.Background {
		t.Fatalf("a fork that writes again after its end runs: %+v", fork)
	}
	if s.QuietSubagents(written+SubagentQuietAfter.Milliseconds()-1, lastWrite) {
		t.Errorf("it counts from its new writes before it is quiet: %+v", s.Subagents()[0])
	}

	parseLines(t, a, s, `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>`+forkAgentId+`</task-id>\n<status>completed</status>\n</task-notification>"},"sessionId":"s","timestamp":"2026-11-05T15:30:00.000Z"}`)
	if fork = s.Subagents()[0]; fork.State != SubagentDone {
		t.Fatalf("its next end ends it again: %+v", fork)
	}
}

// A finished agent whose transcript was last written long ago (a session read again later) stays finished.
func TestOldWriteDoesNotReviveAgent(t *testing.T) {
	s := MakeSession()
	s.StartSubagent("call", "Old job", "fork", "", "", true, 1_000)
	s.SetSubagentId("call", forkAgentId)
	s.SetRecordTime(10_000)
	s.EndSubagent(forkAgentId, "completed")
	now := int64(10_000) + 2*SubagentQuietAfter.Milliseconds()
	if s.ReviveSubagents(now, func(string) int64 { return 10_000 + 5*time.Minute.Milliseconds() }) {
		t.Errorf("a write older than SubagentQuietAfter revives nothing: %+v", s.Subagents())
	}
}

// The companion of a Claude Code pane lists the fork that a queued message resumed after its end as running: its
// sweep reads when the fork last wrote its own transcript.
func TestCompanionListsForkResumedAfterItsEnd(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	session := filepath.Join(dir, "ffff1111-2222-3333-4444-555555555555.jsonl")
	subs := filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	stamp := func(d time.Duration) string { return now.Add(d).UTC().Format(time.RFC3339Nano) }
	lines := []string{
		fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"Render the clips in a fork"}}`, cwd, stamp(-20*time.Minute)),
		fmt.Sprintf(`{"type":"assistant","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fork","name":"Agent","input":{"subagent_type":"fork","description":"Mascot clips"}}]}}`, cwd, stamp(-20*time.Minute)),
		fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fork","content":"Async agent launched successfully."}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":%q}}`, cwd, stamp(-20*time.Minute), forkAgentId),
		fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>toolu_fork</tool-use-id>\n<status>completed</status>\n</task-notification>"}}`, cwd, stamp(-10*time.Minute), forkAgentId),
	}
	if err := os.WriteFile(session, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(subs, "agent-"+forkAgentId+".jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"fork-context-ref","agentId":"`+forkAgentId+`"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	setWritten(t, transcript, now.Add(-time.Minute).UnixMilli())
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b": {BlockId: "b", Agent: "claude", Started: now.Add(-time.Hour).UnixMilli(), Running: true}},
		cwds:  map[string]string{"b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b", "v")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: session}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	v := waitViewLong(t, env, "b", func(v CompanionView) bool {
		return len(v.Subagents) == 1 && v.Subagents[0].State == SubagentRunning
	})
	if v.Subagents[0].Kind != "fork" || v.Subagents[0].Ended != 0 {
		t.Errorf("the resumed fork is listed as running: %+v", v.Subagents[0])
	}
}

func setWritten(t *testing.T, path string, ms int64) {
	t.Helper()
	at := time.UnixMilli(ms)
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}
