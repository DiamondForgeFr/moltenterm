// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

type hookCall struct {
	command string
	route   string
	data    string
}

func recordCalls(calls *[]hookCall) HookCaller {
	return func(command string, route string, data any) error {
		out, _ := json.Marshal(data)
		*calls = append(*calls, hookCall{command, route, string(out)})
		return nil
	}
}

// #988: one handler, the event read from the hook's input, the same for both agents (their documented inputs).
func TestRunHookEvent(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []hookCall
	}{
		{"codex session start", `{"session_id":"019a","transcript_path":"/h/.codex/sessions/2026/10/23/rollout-x.jsonl","cwd":"/w","hook_event_name":"SessionStart","model":"gpt-5.4","permission_mode":"default","source":"startup"}`,
			[]hookCall{
				{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"idle","agent":"codex","start":true}`},
				{CompanionSessionCommand, CompanionRoute, `{"blockid":"b","agent":"codex","path":"/h/.codex/sessions/2026/10/23/rollout-x.jsonl"}`},
			}},
		{"no transcript: the id", `{"session_id":"019a","transcript_path":null,"hook_event_name":"SessionStart","source":"resume"}`,
			[]hookCall{
				{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"idle","agent":"codex","start":true}`},
				{CompanionSessionCommand, CompanionRoute, `{"blockid":"b","agent":"codex","path":"","sessionid":"019a"}`},
			}},
		{"compaction: the link only", `{"session_id":"019a","transcript_path":"/t.jsonl","hook_event_name":"SessionStart","source":"compact"}`,
			[]hookCall{{CompanionSessionCommand, CompanionRoute, `{"blockid":"b","agent":"codex","path":"/t.jsonl"}`}}},
		{"prompt", `{"hook_event_name":"UserPromptSubmit","prompt":"fix it","turn_id":"t1"}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"working","agent":"codex"}`}}},
		{"tool", `{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"output":"a\nb"}}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"working","agent":"codex"}`}}},
		{"stop", `{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Done."}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"done","agent":"codex"}`}}},
		{"permission notification", `{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission"}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"waiting","agent":"codex","message":"Claude needs your permission"}`}}},
		{"idle reminder", `{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}`, nil},
		{"sub-agent start", `{"session_id":"019a","hook_event_name":"SubagentStart","agent_id":"a-1","agent_type":"explorer","turn_id":"t"}`,
			[]hookCall{
				{CompanionSubagentCommand, CompanionRoute, `{"blockid":"b","agent":"codex","event":"start","sessionid":"019a","agentid":"a-1","agenttype":"explorer"}`},
				{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"working","agent":"codex","subagent":"a-1"}`},
			}},
		{"sub-agent stop", `{"session_id":"019a","hook_event_name":"SubagentStop","agent_id":"a-1","agent_type":"explorer","agent_transcript_path":"/h/sub.jsonl","last_assistant_message":null,"stop_hook_active":false}`,
			[]hookCall{
				{CompanionSubagentCommand, CompanionRoute, `{"blockid":"b","agent":"codex","event":"stop","sessionid":"019a","agentid":"a-1","agenttype":"explorer","transcriptpath":"/h/sub.jsonl"}`},
				{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"done","agent":"codex","subagent":"a-1"}`},
			}},
		{"sub-agent start without id: the companion only", `{"hook_event_name":"SubagentStart"}`,
			[]hookCall{{CompanionSubagentCommand, CompanionRoute, `{"blockid":"b","agent":"codex","event":"start"}`}}},
		// #1092: hooks fired inside a sub-agent carry its agent_id and are its own, never the main session's state.
		{"sub-agent tool", `{"session_id":"019a","hook_event_name":"PostToolUse","agent_id":"a-1","agent_type":"explorer","tool_name":"Read"}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"working","agent":"codex","subagent":"a-1"}`}}},
		{"sub-agent stop as Stop", `{"hook_event_name":"Stop","agent_id":"a-1"}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"done","agent":"codex","subagent":"a-1"}`}}},
		{"sub-agent question: the pane waits", `{"hook_event_name":"Notification","agent_id":"a-1","notification_type":"permission_prompt","message":"Claude needs your permission"}`,
			[]hookCall{{AgentStateSetCommand, AgentStatesRoute, `{"blockid":"b","state":"waiting","agent":"codex","message":"Claude needs your permission"}`}}},
		{"another event", `{"hook_event_name":"PreCompact","trigger":"auto"}`, nil},
		{"no input", ``, nil},
	}
	for _, tc := range cases {
		var calls []hookCall
		if err := RunHookEvent(ReadHookInput(strings.NewReader(tc.input)), "codex", "b", recordCalls(&calls)); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if len(calls) != len(tc.want) {
			t.Fatalf("%s: calls %+v, want %+v", tc.name, calls, tc.want)
		}
		for i := range calls {
			if calls[i] != tc.want[i] {
				t.Errorf("%s: call %d %+v, want %+v", tc.name, i, calls[i], tc.want[i])
			}
		}
	}
}

// A tool's output can be large: the input is read as a stream, and the event after it is still found.
func TestReadHookInputStreams(t *testing.T) {
	big := strings.Repeat("x", 3*1024*1024)
	input := `{"tool_response":{"output":"` + big + `","nested":[1,{"a":null}]},"hook_event_name":"PostToolUse","transcript_path":7,"session_id":"s"}`
	got := ReadHookInput(strings.NewReader(input))
	if got.HookEventName != "PostToolUse" || got.SessionId != "s" || got.TranscriptPath != "" {
		t.Fatalf("read %+v", got)
	}
	// Truncated: the fields read until then.
	got = ReadHookInput(io.LimitReader(strings.NewReader(`{"hook_event_name":"Stop","message":"half`), 1024))
	if got.HookEventName != "Stop" || got.Message != "" {
		t.Fatalf("truncated %+v", got)
	}
	if got := ReadHookInput(strings.NewReader(`["not","an","object"]`)); got != (HookInput{}) {
		t.Fatalf("not an object %+v", got)
	}
}

func TestParseHookArgs(t *testing.T) {
	ok := map[string]string{"": "", "--agent codex": "codex", "--agent=claude": "claude", "--agent=": ""}
	for line, agent := range ok {
		ha, valid := ParseHookArgs(strings.Fields(line))
		if !valid || ha.Agent != agent {
			t.Errorf("%q: %+v %v", line, ha, valid)
		}
	}
	for _, line := range []string{"--help", "-h", "--agent", "--agent Bad", "extra", "--agent codex --stdin"} {
		if _, valid := ParseHookArgs(strings.Fields(line)); valid {
			t.Errorf("%q: wsh's", line)
		}
	}
}

// The small program runs `molten agent hook` itself: one connection for a SessionStart's two reports, and nothing on
// stdout (Codex adds a SessionStart hook's output to the model's context).
func TestRunFastHook(t *testing.T) {
	s := startFakeServer(t, "")
	token := testToken(s.sock, "block-1")
	s.token = token
	env, stdout, stderr := envFrom(map[string]string{jwtVarName: token}, `{"hook_event_name":"SessionStart","source":"startup","session_id":"s","transcript_path":"/t.jsonl"}`)
	handled, code := RunFast([]string{"agent", "hook", "--agent", "codex"}, env)
	if !handled || code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("handled %v code %d out %q err %q", handled, code, stdout, stderr)
	}
	reqs := s.requests()
	if len(reqs) != 3 || reqs[0].Command != authenticateCmd || reqs[1].Command != AgentStateSetCommand || reqs[2].Command != CompanionSessionCommand || s.connections() != 1 {
		t.Fatalf("requests %+v, %d connections", reqs, s.connections())
	}
	var state AgentStateRequest
	json.Unmarshal(reqs[1].Data, &state)
	if state != (AgentStateRequest{BlockId: "block-1", State: AgentStateIdle, Agent: "codex", Start: true}) {
		t.Fatalf("state %+v", state)
	}

	// wavesrv's error goes to stderr, never stdout; the hook's `|| true` keeps the agent going.
	s.answer = func(msg rpcMessage) rpcMessage { return rpcMessage{Error: "block x is not a terminal"} }
	env, stdout, stderr = envFrom(map[string]string{jwtVarName: token}, `{"hook_event_name":"Stop"}`)
	if handled, code = RunFast([]string{"agent", "hook", "--agent=codex"}, env); !handled || code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "not a terminal") {
		t.Fatalf("error: handled %v code %d out %q err %q", handled, code, stdout, stderr)
	}

	// An event with nothing to report opens no connection.
	before := s.connections()
	env, _, _ = envFrom(map[string]string{jwtVarName: token}, `{"hook_event_name":"PreCompact"}`)
	if handled, code = RunFast([]string{"agent", "hook", "--agent", "codex"}, env); !handled || code != 0 || s.connections() != before {
		t.Fatalf("PreCompact: handled %v code %d", handled, code)
	}
	// No token, or help: wsh's.
	env, _, _ = envFrom(map[string]string{}, `{"hook_event_name":"Stop"}`)
	if handled, _ := RunFast([]string{"agent", "hook", "--agent", "codex"}, env); handled {
		t.Fatal("no token: wsh's")
	}
	if handled, _ := RunFast([]string{"agent", "hook", "--help"}, env); handled {
		t.Fatal("help: wsh's")
	}
}
