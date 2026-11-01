// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"encoding/json"
	"testing"
)

type hookPayloadCase struct {
	name    string
	payload string
	// state "" means the payload reports no state.
	state   string
	message string
}

// hookConformance holds, for every agent whose precise state comes from its hooks (the state cell of the
// compatibility matrix, FR-AGC-006), payloads shaped as that agent documents them. This package imports the standard
// library only, so the agent ids are written out; agentcontinuity's coherence test names this test for those cells.
var hookConformance = map[string][]hookPayloadCase{
	"claude": {
		{"session start", `{"session_id":"abc","transcript_path":"/h/.claude/projects/p/abc.jsonl","cwd":"/w","hook_event_name":"SessionStart","source":"startup"}`, AgentStateIdle, ""},
		{"prompt", `{"session_id":"abc","hook_event_name":"UserPromptSubmit","prompt":"fix the tests"}`, AgentStateWorking, ""},
		{"tool", `{"session_id":"abc","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"a"}}`, AgentStateWorking, ""},
		{"permission", `{"session_id":"abc","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}`, AgentStateWaiting, "Claude needs your permission to use Bash"},
		{"idle reminder", `{"session_id":"abc","hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}`, "", ""},
		{"stop", `{"session_id":"abc","hook_event_name":"Stop","stop_hook_active":false}`, AgentStateDone, ""},
	},
	"codex": {
		{"session start", `{"session_id":"019a","transcript_path":"/h/.codex/sessions/2026/11/01/rollout-x.jsonl","cwd":"/w","hook_event_name":"SessionStart","model":"gpt-5.4","source":"startup"}`, AgentStateIdle, ""},
		{"prompt", `{"session_id":"019a","hook_event_name":"UserPromptSubmit","prompt":"fix the tests","turn_id":"t1"}`, AgentStateWorking, ""},
		{"tool", `{"session_id":"019a","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"output":"a"}}`, AgentStateWorking, ""},
		{"stop", `{"session_id":"019a","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Done."}`, AgentStateDone, ""},
	},
}

// FR-AGC-006: each agent's hook payloads, run through `molten agent hook --agent <id>` against a fake wavesrv, give
// the state the matrix promises.
func TestHookPayloadConformance(t *testing.T) {
	for agent, cases := range hookConformance {
		for _, tc := range cases {
			t.Run(agent+"/"+tc.name, func(t *testing.T) {
				s := startFakeServer(t, "")
				token := testToken(s.sock, "block-1")
				s.token = token
				env, stdout, stderr := envFrom(map[string]string{jwtVarName: token}, tc.payload)
				handled, code := RunFast([]string{"agent", "hook", "--agent", agent}, env)
				if !handled || code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
					t.Fatalf("handled %v code %d out %q err %q", handled, code, stdout, stderr)
				}
				var states []AgentStateRequest
				for _, req := range s.requests() {
					if req.Command != AgentStateSetCommand {
						continue
					}
					var sent AgentStateRequest
					if err := json.Unmarshal(req.Data, &sent); err != nil {
						t.Fatal(err)
					}
					states = append(states, sent)
				}
				if tc.state == "" {
					if len(states) != 0 {
						t.Fatalf("no state expected, got %+v", states)
					}
					return
				}
				if len(states) != 1 {
					t.Fatalf("one state expected, got %+v", states)
				}
				got := states[0]
				if got.BlockId != "block-1" || got.Agent != agent || got.State != tc.state || got.Message != tc.message {
					t.Fatalf("state %+v, want %s %q for %s", got, tc.state, tc.message, agent)
				}
			})
		}
	}
}
