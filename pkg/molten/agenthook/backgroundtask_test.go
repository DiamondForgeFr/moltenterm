// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// #2140: Claude Code's PostToolUse of a Bash call left in the background (recorded from Claude Code 2.1).
const backgroundBashPayload = `{"session_id":"abc","transcript_path":"/h/.claude/projects/p/abc.jsonl","cwd":"/w","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"until gh pr checks 2140; do sleep 30; done","description":"Wait for the CI","run_in_background":true},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"bz4ehrk6q"},"tool_use_id":"toolu_01"}`

func TestReadHookInputBackgroundCommand(t *testing.T) {
	t.Parallel()
	input := ReadHookInput(strings.NewReader(backgroundBashPayload))
	if input.ToolName != "Bash" || input.ToolDescription != "Wait for the CI" || input.BackgroundTaskId != "bz4ehrk6q" {
		t.Fatalf("%+v", input)
	}
	var sent []AgentStateRequest
	call := func(command string, route string, data any) error {
		sent = append(sent, data.(AgentStateRequest))
		return nil
	}
	if err := RunHookEvent(input, "claude", "b1", call); err != nil {
		t.Fatal(err)
	}
	want := AgentStateRequest{BlockId: "b1", State: AgentStateWorking, Agent: "claude", BackgroundTask: "bz4ehrk6q", BackgroundDescription: "Wait for the CI", Transcript: "/h/.claude/projects/p/abc.jsonl", SessionId: "abc"}
	if len(sent) != 1 || !reflect.DeepEqual(sent[0], want) {
		t.Fatalf("sent %+v", sent)
	}

	// A foreground call, and a response that is not an object, tell no background command.
	for _, payload := range []string{
		`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"a"}}`,
		`{"hook_event_name":"PostToolUse","tool_name":"exec_command","tool_input":"ls","tool_response":"backgroundTaskId"}`,
	} {
		if in := ReadHookInput(strings.NewReader(payload)); in.BackgroundTaskId != "" {
			t.Fatalf("%s: %+v", payload, in)
		}
	}
}

// #2583: the hook reads the command line once, to tell a service from bounded work, and sends the answer: the line
// itself never leaves the hook.
func TestBackgroundCommandIsAServiceByItsCommandLine(t *testing.T) {
	t.Parallel()
	payload := func(command string) string {
		return strings.Replace(backgroundBashPayload, "until gh pr checks 2140; do sleep 30; done", command, 1)
	}
	for command, service := range map[string]bool{
		"cd app && npm run dev":                      true,
		"node ~/x/molten-browser.mjs daemon":         true,
		"molten mcp browser":                         true,
		"tail -f build.log":                          true,
		"sleep 600":                                  false,
		"molten ci run":                              false,
		"gh pr checks 2140 --watch":                  false,
		"until gh pr checks 2140; do sleep 30; done": false,
		"npx vitest run frontend/a.test.ts":          false,
	} {
		input := ReadHookInput(strings.NewReader(payload(command)))
		if input.ToolCommand != command {
			t.Fatalf("%q: read %q", command, input.ToolCommand)
		}
		var sent []AgentStateRequest
		call := func(_ string, _ string, data any) error {
			sent = append(sent, data.(AgentStateRequest))
			return nil
		}
		if err := RunHookEvent(input, "claude", "b1", call); err != nil {
			t.Fatal(err)
		}
		if len(sent) != 1 || sent[0].BackgroundService != service || sent[0].BackgroundTask != "bz4ehrk6q" {
			t.Fatalf("%q: sent %+v, want service %v", command, sent, service)
		}
		if raw, _ := json.Marshal(sent[0]); strings.Contains(string(raw), "daemon") || strings.Contains(string(raw), "tail -f") {
			t.Fatalf("%q: the command line is never sent: %s", command, raw)
		}
	}

	// A response that tells no background command sends no service.
	input := ReadHookInput(strings.NewReader(`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"npm run dev"},"tool_response":{"stdout":"a"}}`))
	var sent []AgentStateRequest
	if err := RunHookEvent(input, "claude", "b1", func(_ string, _ string, data any) error {
		sent = append(sent, data.(AgentStateRequest))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].BackgroundService || sent[0].BackgroundTask != "" {
		t.Fatalf("a foreground command: %+v", sent)
	}
}

func TestTaskNotificationEnds(t *testing.T) {
	t.Parallel()
	note := func(id string) string {
		return `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>` + id + `</task-id>\n<status>completed</status>\n</task-notification>"}}` + "\n"
	}
	// The first marker straddles the first chunk's end.
	pad := strings.Repeat("x", TaskNotificationScanChunk-len(`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>b1`))
	data := pad + note("b1aaaaaaa") + strings.Repeat("y", TaskNotificationScanChunk) + note("b3ccccccc")
	got := TaskNotificationEnds(strings.NewReader(data), []string{"b1aaaaaaa", "b2bbbbbbb", "b3ccccccc"})
	if !reflect.DeepEqual(got, []string{"b1aaaaaaa", "b3ccccccc"}) {
		t.Fatalf("ended %v", got)
	}
	if got := TaskNotificationEnds(strings.NewReader(data), nil); got != nil {
		t.Fatalf("no ids: %v", got)
	}
}

// #2582: the lines Claude Code 2.1.332 writes when the agent stops a background command with TaskStop. No task
// notification follows: the tool's result is the end.
func taskStopLines(id string, command string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_stop","name":"TaskStop","input":{"task_id":"` + id + `"}}]}}` + "\n" +
		`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_stop","type":"tool_result","content":"{\"message\":\"Successfully stopped task: ` + id + ` (` + command + `)\",\"task_id\":\"` + id + `\",\"task_type\":\"local_bash\",\"command\":\"` + command + `\"}"}]},"toolUseResult":{"message":"Successfully stopped task: ` + id + ` (` + command + `)","task_id":"` + id + `","task_type":"local_bash","command":"` + command + `"}}` + "\n"
}

func TestTaskNotificationEndsReadsATaskStop(t *testing.T) {
	t.Parallel()
	data := taskStopLines("bstop0001", "sleep 600") +
		// A TaskStop that found nothing to stop, and one the machine did not confirm, end nothing.
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_x","name":"TaskStop","input":{"task_id":"bgone0002"}}]}}` + "\n" +
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"<tool_use_error>Task bgone0002 is not running (status: completed)</tool_use_error>","is_error":true,"tool_use_id":"toolu_x"}]}}` + "\n" +
		`{"type":"user","toolUseResult":{"message":"Task bmaybe003 may still be running: the machine that runs it did not confirm the stop.","task_id":"bmaybe003","task_type":"local_bash"}}` + "\n"
	got := TaskNotificationEnds(strings.NewReader(data), []string{"bstop0001", "bgone0002", "bmaybe003", "bstop"})
	if !reflect.DeepEqual(got, []string{"bstop0001"}) {
		t.Fatalf("only the stopped command ended, not an id it starts with: %v", got)
	}

	// The stop's marker straddles the first read's end (a chunk plus the longest marker's overlap).
	marker := `Successfully stopped task: bcut00004 (`
	prefix := `{"type":"user","toolUseResult":{"message":"`
	pad := strings.Repeat("x", TaskNotificationScanChunk+len(marker)-1-len(prefix)-10)
	cut := pad + prefix + marker + `go test ./...)","task_id":"bcut00004","task_type":"local_bash"}}` + "\n"
	if got := TaskNotificationEnds(strings.NewReader(cut), []string{"bcut00004"}); !reflect.DeepEqual(got, []string{"bcut00004"}) {
		t.Fatalf("a marker cut between two reads: %v", got)
	}
}
