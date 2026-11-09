// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
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
	want := AgentStateRequest{BlockId: "b1", State: AgentStateWorking, Agent: "claude", BackgroundTask: "bz4ehrk6q", BackgroundDescription: "Wait for the CI", Transcript: "/h/.claude/projects/p/abc.jsonl"}
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
