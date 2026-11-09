// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"strings"
	"testing"
)

// #2142: the main session's working and done reports carry its transcript, in the state request itself (no request
// of their own), so a restarted wavesrv links the pane again; a sub-agent's never do.
func TestHookStateReportsCarryTheTranscript(t *testing.T) {
	t.Parallel()
	const transcript = "/h/.claude/projects/p/abc.jsonl"
	for _, c := range []struct {
		payload string
		want    string
	}{
		{`{"hook_event_name":"UserPromptSubmit","session_id":"abc","transcript_path":"` + transcript + `","prompt":"fix it"}`, transcript},
		{`{"hook_event_name":"PostToolUse","session_id":"abc","transcript_path":"` + transcript + `","tool_name":"Bash","tool_response":{"stdout":"ok"}}`, transcript},
		{`{"hook_event_name":"Stop","session_id":"abc","transcript_path":"` + transcript + `"}`, transcript},
		{`{"hook_event_name":"PostToolUse","session_id":"abc","transcript_path":"` + transcript + `","agent_id":"a1","tool_name":"Bash"}`, ""},
		{`{"hook_event_name":"UserPromptSubmit","session_id":"abc"}`, ""},
	} {
		var sent []any
		call := func(command string, route string, data any) error {
			sent = append(sent, data)
			return nil
		}
		if err := RunHookEvent(ReadHookInput(strings.NewReader(c.payload)), "claude", "b1", call); err != nil {
			t.Fatal(err)
		}
		if len(sent) != 1 {
			t.Fatalf("%s: %d requests, want one", c.payload, len(sent))
		}
		req, ok := sent[0].(AgentStateRequest)
		if !ok || req.Transcript != c.want {
			t.Errorf("%s: sent %+v, want the transcript %q", c.payload, sent[0], c.want)
		}
	}
}
