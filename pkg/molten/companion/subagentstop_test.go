// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #2529: a sub-agent stops a background command of its own whose command line holds quotes. Claude Code writes the
// stop's message as JSON, the quotes escaped; the stop must still end that task, or the agent's finished meta reads as
// waiting on its own work for hours and the Integration card keeps it at work over a mergeable pull request.

func bgStopLine(taskId string, command string) string {
	escaped := strings.ReplaceAll(strings.ReplaceAll(command, `\`, `\\`), `"`, `\"`)
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_stop","content":"{\"message\":\"Successfully stopped task\"}"}]},"toolUseResult":{"message":"Successfully stopped task: ` + taskId + ` (` + escaped + `)","task_id":"` + taskId + `","task_type":"local_bash","command":"` + escaped + `"}}`
}

func bgQuotedLaunchCall(callId string, command string) string {
	escaped := strings.ReplaceAll(strings.ReplaceAll(command, `\`, `\\`), `"`, `\"`)
	return `{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"tool_use","id":"` + callId + `","name":"Bash","input":{"command":"` + escaped + `","run_in_background":true}}]}}`
}

func TestClaudeBackgroundStopOfACommandWithQuotes(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		command string
	}{
		{"quotes", `bash wait-proc.sh "vitest run --reporter=dot"`},
		{"a backslash before the quotes", `bash wait-proc.sh "a\\b" \"c\"`},
		{"a stop-shaped text inside the command", `echo "\",\"task_id\":\"other\""`},
	}
	for _, tc := range cases {
		lines := []string{bgLaunchLine("b1"), bgStopLine("b1", tc.command), bgTurnEndLine}
		if claudeBackgroundPending([]byte(strings.Join(lines, "\n") + "\n")) {
			t.Errorf("%s: a task its agent stopped is not pending", tc.name)
		}
	}
	lines := []string{bgLaunchLine("b1"), bgLaunchLine("b2"), bgStopLine("b1", `bash wait-proc.sh "go test"`), bgTurnEndLine}
	tasks := claudeBackgroundTasks([]byte(strings.Join(lines, "\n") + "\n"))
	if len(tasks) != 1 || tasks[0].id != "b2" {
		t.Errorf("the stop ends its own task only: %+v", tasks)
	}
}

// The agent of the report: launched in the background with a worktree, it ran background commands and stopped some of
// them, ended, was resumed by SendMessage to rebase its pull request, ran more and ended again. Its meta says finished.
func resumedAgentTranscript(stopQuoted bool) []string {
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"Build the ticket."}}`,
		bgQuotedLaunchCall("toolu_l1", `bash wait-proc.sh "vitest run --reporter=dot"`),
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_l1","content":"Command running in background with ID: bquoted"}]},"toolUseResult":{"stdout":"","backgroundTaskId":"bquoted"}}`,
		bgLaunchLine("bplain"),
		bgEndLine("bplain"),
	}
	if stopQuoted {
		lines = append(lines, bgStopLine("bquoted", `bash wait-proc.sh "vitest run --reporter=dot"`))
	}
	return append(lines,
		`{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"The draft PR is open."}]}}`,
		`{"type":"user","message":{"role":"user","content":"Rebase the PR onto develop."}}`,
		bgLaunchLine("brebase"),
		bgEndLine("brebase"),
		`{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Rebased and pushed."}]}}`,
	)
}

func TestFilesEndAResumedAgentThatStoppedAQuotedCommand(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	const agentId = "a2529000000ended"
	ended := time.Now().Add(-20 * time.Minute)
	f.agent(agentId, "toolu_build", "#9529 build", true, ended.Add(time.Second), time.Time{})
	writeSubagentTranscript(t, f, agentId, ended, resumedAgentTranscript(true)...)

	ids := ApplyHookSubagents(a.ListSubagents(f.session), nil, time.Now())
	if len(ids) != 1 || !ids[0].Finished || ids[0].Waiting || ids[0].State != SubagentDone {
		t.Fatalf("a finished agent whose background commands all ended or were stopped is done: %+v", ids)
	}
	if work := leadWorkOf(ids); len(work) != 0 {
		t.Errorf("no sub-agent at work is recorded for the Integration card: %+v", work)
	}
	id, ok := a.SubagentFile(f.session, agentId)
	if !ok || !id.Finished || id.Waiting {
		t.Fatalf("the settle's read of the agent's files agrees: %+v", id)
	}

	// The parent's transcript started it, then resumed it by SendMessage; the end of the resumed run is not at hand
	// (the files are the reader's only source): its files end it.
	s := MakeSession()
	s.StartSubagent("toolu_build", "#9529 build", "sf-build", "", "", true, ended.Add(-time.Hour).UnixMilli())
	s.SetSubagentId("toolu_build", agentId)
	s.WakeSubagent(agentId, ended.Add(-10*time.Minute).UnixMilli())
	if !s.SettleSubagentFiles([]SubagentIdentity{id}, time.Now().UnixMilli()) {
		t.Fatal("the files end the resumed agent")
	}
	if sub := s.Subagents()[0]; sub.State != SubagentDone || sub.Waiting {
		t.Errorf("the resumed agent reads as done: %+v", sub)
	}
}

// #2498 unchanged: the same agent with its quoted command still running waits on it and stays at work.
func TestFilesKeepAnAgentWaitingOnAQuotedCommand(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	const agentId = "a2529000000waits"
	ended := time.Now().Add(-20 * time.Minute)
	f.agent(agentId, "toolu_build", "#9529 build", true, ended.Add(time.Second), time.Time{})
	writeSubagentTranscript(t, f, agentId, ended, resumedAgentTranscript(false)...)

	ids := ApplyHookSubagents(a.ListSubagents(f.session), nil, time.Now())
	if len(ids) != 1 || ids[0].Finished || !ids[0].Waiting || ids[0].State != SubagentRunning || len(ids[0].Jobs) != 1 {
		t.Fatalf("an agent whose own background command still runs waits on it: %+v", ids)
	}
	if work := leadWorkOf(ids); len(work) != 1 || !work[0].Waiting {
		t.Errorf("it stays at work for the Integration card: %+v", work)
	}
}
