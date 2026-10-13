// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"strings"
	"testing"
)

func TestClaudeRecap(t *testing.T) {
	s := MakeSession()
	a := MakeClaudeAdapter([]string{"/nowhere"})
	parseFile(t, a, s, "claude-recap.jsonl")
	if s.Name() != "Login redirect and release notes" {
		t.Errorf("the session takes Claude Code's own title: %q", s.Name())
	}
	topics := s.Topics()
	if len(topics) != 2 {
		t.Fatalf("a question that did no work is not a topic: %+v", topics)
	}
	if topics[0].Text != "Write the release notes and audit the docs in the background" || topics[0].Tools != 3 {
		t.Errorf("the newest topic comes first, with its calls: %+v", topics[0])
	}
	first := topics[1]
	if first.Text != "Fix the login redirect after sign-out" || first.Files != 1 || len(first.PRs) != 1 || first.PRs[0].Number != 42 {
		t.Errorf("a topic carries its files and the PR first recorded during it: %+v", first)
	}
	if first.Branch != "fix/41-login-redirect" || topics[0].Branch != "feature/43-release-notes" || s.Branch() != "feature/43-release-notes" {
		t.Errorf("each topic keeps the branch of its own work: %q, %q, session %q", first.Branch, topics[0].Branch, s.Branch())
	}
	agents := s.Subagents()
	if len(agents) != 2 {
		t.Fatalf("both agents are listed: %+v", agents)
	}
	bg, fg := agents[0], agents[1]
	if bg.State != SubagentRunning || !bg.Background || bg.Model != "sonnet" || bg.Kind != "general-purpose" || bg.Description != "Audit the docs" {
		t.Errorf("a background agent keeps running after its call returns: %+v", bg)
	}
	if fg.State != SubagentRunning || fg.Background || fg.Kind != "writer" {
		t.Errorf("a foreground agent runs until its result: %+v", fg)
	}
	act := s.Activity()
	if act == nil || act.Tool != "Bash" || act.Target != "Run the tests" {
		t.Errorf("the latest call names its description: %+v", act)
	}

	s.SetRecordTime(1_900_000_000_000)
	notification := `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>agent-bg</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Audit the docs\" finished</summary>\n</task-notification>"},"uuid":"u7","sessionId":"aaaa1111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:00.000Z"}`
	parseRecordLine(a, s, []byte(notification))
	result := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"agent-fg","content":"boom","is_error":true}]},"toolUseResult":{"status":"completed"},"uuid":"u8","sessionId":"aaaa1111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:01.000Z"}`
	parseRecordLine(a, s, []byte(result))
	agents = s.Subagents()
	if agents[0].State != SubagentDone || agents[0].Ended == 0 {
		t.Errorf("the notification ends the background agent: %+v", agents[0])
	}
	if agents[1].State != SubagentFailed {
		t.Errorf("an error result fails the foreground agent: %+v", agents[1])
	}
	for _, p := range s.Digest().Prompts {
		if strings.Contains(p.Text, "task-notification") || strings.Contains(p.Text, "finished") {
			t.Errorf("a notification is not a prompt of the user: %q", p.Text)
		}
	}
	if len(s.Topics()) != 2 {
		t.Errorf("a notification starts no topic: %+v", s.Topics())
	}
}

func TestCustomTitleWins(t *testing.T) {
	s := MakeSession()
	s.SetSessionName("Generated", false)
	s.SetSessionName("Mine", true)
	s.SetSessionName("Generated again", false)
	if s.Name() != "Mine" {
		t.Errorf("the user's /rename wins over the generated title: %q", s.Name())
	}
}

func TestLargeNotificationEndsAgent(t *testing.T) {
	s := MakeSession()
	s.StartSubagent("bg", "Long job", "general-purpose", "", true, 1)
	huge := `{"type":"user","message":{"role":"user","content":"<task-notification><tool-use-id>bg</tool-use-id><status>killed</status><result>` + strings.Repeat("z", largeRecordBytes+10) + `</result></task-notification>"}}`
	parseRecordLine(MakeClaudeAdapter([]string{"/nowhere"}), s, []byte(huge))
	if got := s.Subagents()[0].State; got != SubagentStopped {
		t.Errorf("a large notification still ends its agent: %s", got)
	}
	s.StartSubagent("fg", "Short job", "", "", false, 1)
	launched := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"fg","content":"` + strings.Repeat("y", largeRecordBytes+10) + `"}]}}`
	parseRecordLine(MakeClaudeAdapter([]string{"/nowhere"}), s, []byte(launched))
	if got := s.Subagents()[1].State; got != SubagentDone {
		t.Errorf("a large result ends a foreground agent: %s", got)
	}
}

func TestSubagentsAreCapped(t *testing.T) {
	s := MakeSession()
	s.StartSubagent("keep", "still running", "", "", true, 1)
	for i := 0; i < MaxSubagents+5; i++ {
		id := strings.Repeat("x", i+1)
		s.StartSubagent(id, "job", "", "", false, 1)
		s.SubagentResult(id, false, false, "")
	}
	list := s.Subagents()
	if len(list) != MaxSubagents || list[0].Id != "keep" {
		t.Errorf("ended agents go first, a running one stays: %d, first %q", len(list), list[0].Id)
	}
}

func TestActivityTarget(t *testing.T) {
	cases := []struct {
		input map[string]any
		want  string
	}{
		{map[string]any{"command": "ls", "description": "List"}, "List"},
		{map[string]any{"file_path": "/a/b.go"}, "/a/b.go"},
		{map[string]any{"command": []any{"bash", "-lc", "go test"}}, "go test"},
		{map[string]any{"cmd": "npm run build"}, "npm run build"},
		{nil, ""},
	}
	for _, c := range cases {
		if got := activityTarget(c.input); got != c.want {
			t.Errorf("activityTarget(%v) = %q, want %q", c.input, got, c.want)
		}
	}
}
