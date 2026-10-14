// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #600: Claude Code runs its SessionStart hook after /clear before it writes the new transcript. The report of that
// missing file is accepted, the companion leaves the previous session and follows the new one once it appears; a
// second report for an already linked pane moves it too, and the pane's earlier sessions stay reachable.
func TestClearFollowsNewSession(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	start := time.Now().Add(-time.Minute).UnixMilli()
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b": {BlockId: "b", Agent: "claude", Started: start, Running: true}},
		cwds:  map[string]string{"b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b", "v")

	first := filepath.Join(dir, "first.jsonl")
	writeNowSession(t, first, cwd, "before the clear")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: first}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && v.Session.LinkedBy == LinkHook && v.Latest != nil && v.Latest.Markdown == "before the clear"
	})

	second := filepath.Join(dir, "second.jsonl")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: second}); err != nil {
		t.Fatalf("a reported transcript that does not exist yet is accepted: %v", err)
	}
	v := waitView(t, env, "b", func(v CompanionView) bool { return v.Status == StatusSearching && v.Session == nil })
	if len(v.Earlier) != 1 || v.Earlier[0].Path != canonicalPath(first) || v.Earlier[0].Title == "" {
		t.Fatalf("the previous session is kept as an earlier one: %+v", v.Earlier)
	}
	if _, path, ok := m.LinkedSession("b"); ok {
		t.Errorf("no session is linked while the new one has no transcript: %s", path)
	}

	writeNowSession(t, second, cwd, "after the clear")
	v = waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "second.jsonl" && v.Latest != nil
	})
	if v.Session.LinkedBy != LinkHook || v.Latest.Markdown != "after the clear" || len(v.Answers) != 1 {
		t.Fatalf("the new session's answers only: %+v %+v", v.Session, v.Answers)
	}
	if _, path, ok := m.LinkedSession("b"); !ok || filepath.Base(path) != "second.jsonl" {
		t.Errorf("linked once its transcript exists: %s %v", path, ok)
	}

	// A second report for a pane already linked (a resume) moves it at once.
	third := filepath.Join(dir, "third.jsonl")
	writeNowSession(t, third, cwd, "resumed")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: third}); err != nil {
		t.Fatal(err)
	}
	v = waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "third.jsonl" && v.Latest != nil
	})
	if len(v.Earlier) != 2 || filepath.Base(v.Earlier[0].Path) != "second.jsonl" || filepath.Base(v.Earlier[1].Path) != "first.jsonl" {
		t.Fatalf("earlier sessions, newest first: %+v", v.Earlier)
	}

	list, err := m.Sessions("b", "v")
	if err != nil || len(list) != 3 || !list[0].Current || !list[1].Earlier || !list[2].Earlier {
		t.Fatalf("history: the current session, then the earlier ones: %+v %v", list, err)
	}

	// The user looks at an earlier session: it shows, flagged, while the agent's own session stays the linked one.
	if _, err := m.Pick("b", "v", first); err != nil {
		t.Fatal(err)
	}
	v = waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "first.jsonl" && v.Latest != nil
	})
	if !v.Session.Earlier || v.Latest.Markdown != "before the clear" || filepath.Base(v.Session.LivePath) != "third.jsonl" {
		t.Fatalf("an earlier session is flagged, with the agent's own: %+v", v.Session)
	}
	if len(v.Earlier) != 1 || filepath.Base(v.Earlier[0].Path) != "second.jsonl" {
		t.Errorf("the agent's own session is not an earlier one: %+v", v.Earlier)
	}
	list, err = m.Sessions("b", "v")
	if err != nil || len(list) != 3 || !list[0].Current || !list[1].Live || filepath.Base(list[1].Path) != "third.jsonl" || !list[2].Earlier {
		t.Fatalf("history while an earlier session shows: %+v %v", list, err)
	}
	if _, path, ok := m.LinkedSession("b"); !ok || filepath.Base(path) != "third.jsonl" {
		t.Errorf("the agent's session stays the linked one: %s", path)
	}
	if _, err := m.Pick("b", "v", ""); err != nil {
		t.Fatal(err)
	}
	v = waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "third.jsonl"
	})
	if v.Session.Earlier || v.Session.LinkedBy != LinkHook {
		t.Errorf("back to the current session: %+v", v.Session)
	}
}

func TestReportedPathChecks(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-work-demo")
	os.MkdirAll(dir, 0o700)
	a := MakeClaudeAdapter([]string{root})
	path, pending, err := ValidateReportedSessionPath(a, filepath.Join(dir, "new.jsonl"))
	if err != nil || !pending || filepath.Base(path) != "new.jsonl" {
		t.Errorf("a missing transcript in the session folder is pending: %s %v %v", path, pending, err)
	}
	if _, _, err := ValidateReportedSessionPath(a, filepath.Join(root, "new.jsonl")); err == nil {
		t.Error("a missing transcript outside the layout is refused")
	}
	if _, _, err := ValidateReportedSessionPath(a, filepath.Join(root, "absent", "new.jsonl")); err == nil {
		t.Error("a missing folder is refused")
	}
	outside := t.TempDir()
	if _, _, err := ValidateReportedSessionPath(a, filepath.Join(outside, "x", "new.jsonl")); err == nil {
		t.Error("a missing transcript outside the roots is refused")
	}
	target := filepath.Join(outside, "real.jsonl")
	os.WriteFile(target, []byte("{}\n"), 0o600)
	link := filepath.Join(dir, "link.jsonl")
	os.Symlink(target, link)
	if _, _, err := ValidateReportedSessionPath(a, link); err == nil {
		t.Error("a link out of the roots is refused, not taken as pending")
	}
	dangling := filepath.Join(dir, "dangling.jsonl")
	os.Symlink(filepath.Join(outside, "gone.jsonl"), dangling)
	if _, _, err := ValidateReportedSessionPath(a, dangling); err == nil {
		t.Error("a dangling link is refused, not taken as pending")
	}
}

func launchBackground(t *testing.T, a *ClaudeAdapter, s *Session, callId string, agentId string, at string) {
	t.Helper()
	call := `{"type":"assistant","sessionId":"s","timestamp":"` + at + `","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + callId + `","name":"Agent","input":{"description":"Job ` + callId + `","subagent_type":"general-purpose","run_in_background":true}}]}}`
	result := `{"type":"user","sessionId":"s","timestamp":"` + at + `","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + callId + `","content":"launched"}]},"toolUseResult":{"status":"async_launched","agentId":"` + agentId + `"}}`
	parseRecordLine(a, s, []byte(call))
	parseRecordLine(a, s, []byte(result))
}

func subagentState(s *Session, id string) string {
	for _, sa := range s.Subagents() {
		if sa.Id == id {
			return sa.State
		}
	}
	return ""
}

// #600: a background agent's end reaches the transcript as a queued command or a queue operation as well as a message
// of the user, and an agent left over from a previous run is named by its agent id.
func TestBackgroundAgentEnds(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	at := "2026-10-14T08:00:00.000Z"
	launchBackground(t, a, s, "call-q", "aq1", at)
	launchBackground(t, a, s, "call-a", "aa1", at)
	launchBackground(t, a, s, "call-x", "ax1", at)
	launchBackground(t, a, s, "call-y", "ay1", at)
	for _, id := range []string{"call-q", "call-a", "call-x", "call-y"} {
		if got := subagentState(s, id); got != SubagentRunning {
			t.Fatalf("%s runs after its launch: %s", id, got)
		}
	}
	queued := `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-14T08:10:00.000Z","sessionId":"s","content":"<task-notification>\n<task-id>aq1</task-id>\n<tool-use-id>call-q</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>"}`
	parseRecordLine(a, s, []byte(queued))
	if got := subagentState(s, "call-q"); got != SubagentDone {
		t.Errorf("a queued notification ends the agent: %s", got)
	}
	attachment := `{"type":"attachment","timestamp":"2026-10-14T08:11:00.000Z","sessionId":"s","attachment":{"type":"queued_command","prompt":"<task-notification>\n<tool-use-id>call-a</tool-use-id>\n<status>failed</status>\n</task-notification>","origin":{"kind":"task-notification"}}}`
	parseRecordLine(a, s, []byte(attachment))
	if got := subagentState(s, "call-a"); got != SubagentFailed {
		t.Errorf("a queued command's notification ends the agent: %s", got)
	}
	leftover := `{"type":"user","sessionId":"s","timestamp":"2026-10-14T08:12:00.000Z","message":{"role":"user","content":"<task-notification>\n<task-id>ax1</task-id>\n<task-id>ay1</task-id>\n<status>stopped</status>\n<summary>2 background agents did not finish before the previous session ended</summary>\n</task-notification>"}}`
	parseRecordLine(a, s, []byte(leftover))
	if subagentState(s, "call-x") != SubagentStopped || subagentState(s, "call-y") != SubagentStopped {
		t.Errorf("agents named by their agent ids are stopped: %+v", s.Subagents())
	}
	if len(s.Topics()) != 0 {
		t.Errorf("notifications start no topic: %+v", s.Topics())
	}
}

// A background agent whose end was never recorded leaves the running ones once it wrote nothing for long, and comes
// back if it writes again.
func TestQuietBackgroundAgent(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-work-demo")
	os.MkdirAll(filepath.Join(dir, "sess", "subagents"), 0o700)
	session := filepath.Join(dir, "sess.jsonl")
	a := MakeClaudeAdapter([]string{root})
	s := MakeSession()
	old := time.Now().Add(-3 * time.Hour)
	launchBackground(t, a, s, "call-old", "aold1", old.UTC().Format(time.RFC3339Nano))
	launchBackground(t, a, s, "call-busy", "abusy1", old.UTC().Format(time.RFC3339Nano))
	launchBackground(t, a, s, "call-new", "anew1", time.Now().UTC().Format(time.RFC3339Nano))
	busy := filepath.Join(dir, "sess", "subagents", "agent-abusy1.jsonl")
	os.WriteFile(busy, []byte("{}\n"), 0o600)
	lastWrite := func(id string) int64 { return a.SubagentWritten(session, id) }
	now := time.Now().UnixMilli()
	if !s.QuietSubagents(now, lastWrite) {
		t.Fatal("an old silent agent changes state")
	}
	if subagentState(s, "call-old") != SubagentQuiet || subagentState(s, "call-busy") != SubagentRunning || subagentState(s, "call-new") != SubagentRunning {
		t.Errorf("only the silent agent goes quiet: %+v", s.Subagents())
	}
	stale := time.Now().Add(-2 * time.Hour)
	os.Chtimes(busy, stale, stale)
	s.QuietSubagents(now, lastWrite)
	if subagentState(s, "call-busy") != SubagentQuiet {
		t.Errorf("an agent whose transcript stopped long ago goes quiet: %+v", s.Subagents())
	}
	os.Chtimes(busy, time.Now(), time.Now())
	s.QuietSubagents(time.Now().UnixMilli(), lastWrite)
	if subagentState(s, "call-busy") != SubagentRunning {
		t.Errorf("a quiet agent that writes again runs: %+v", s.Subagents())
	}
	if a.SubagentWritten(session, "../x") != 0 {
		t.Error("an agent id never names another file")
	}
}
