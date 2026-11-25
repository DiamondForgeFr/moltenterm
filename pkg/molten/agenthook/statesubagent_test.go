// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

// Hook inputs as Claude Code pipes them: the lead's own tool, a background sub-agent's tool, a sub-agent's permission
// prompt (synthetic ids).
const (
	legacyMainTool    = `{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"Bash"}`
	legacySubTool     = `{"hook_event_name":"PostToolUse","session_id":"s","agent_id":"a-1","agent_type":"general-purpose","tool_name":"Read"}`
	legacySubQuestion = `{"hook_event_name":"Notification","session_id":"s","agent_id":"a-1","notification_type":"permission_prompt","message":"Claude needs your permission"}`
)

// runLegacyState runs `molten agent state` with the hook's input on stdin against a fake wavesrv and returns what it
// sent.
func runLegacyState(t *testing.T, stdin io.Reader, args ...string) AgentStateRequest {
	t.Helper()
	s := startFakeServer(t, "")
	token := testToken(s.sock, "block-1")
	s.token = token
	env, _, stderr := envFrom(map[string]string{jwtVarName: token}, "")
	env.Stdin = stdin
	handled, code := RunFast(append([]string{"agent", "state"}, args...), env)
	if !handled || code != 0 {
		t.Fatalf("%v: handled %v code %d err %q", args, handled, code, stderr)
	}
	reqs := s.requests()
	if len(reqs) != 2 || reqs[1].Command != AgentStateSetCommand {
		t.Fatalf("%v: requests %+v", args, reqs)
	}
	var sent AgentStateRequest
	if err := json.Unmarshal(reqs[1].Data, &sent); err != nil {
		t.Fatal(err)
	}
	return sent
}

func input(text string) io.Reader {
	return strings.NewReader(text)
}

// #2536: the hooks pasted from an earlier agent-states.md run `molten agent state working --agent claude` on every
// PostToolUse, also inside a background sub-agent. The input names the sub-agent: the report is the sub-agent's, so the
// lead whose turn ended keeps a free prompt.
func TestLegacyWorkingHookOfASubagentReportsTheSubagent(t *testing.T) {
	sent := runLegacyState(t, input(legacySubTool), "working", "--agent", "claude")
	want := AgentStateRequest{BlockId: "block-1", State: "working", Agent: "claude", Subagent: "a-1"}
	if sent != want {
		t.Fatalf("sent %+v, want %+v", sent, want)
	}
	sent = runLegacyState(t, input(legacySubTool), "working", "--agent", "claude", "--stdin")
	if sent.Subagent != "a-1" {
		t.Fatalf("with --stdin: %+v", sent)
	}
}

// The lead's own tool is the lead's turn: busy.
func TestLegacyWorkingHookOfTheSessionReportsTheSession(t *testing.T) {
	sent := runLegacyState(t, input(legacyMainTool), "working", "--agent", "claude")
	want := AgentStateRequest{BlockId: "block-1", State: "working", Agent: "claude"}
	if sent != want {
		t.Fatalf("sent %+v, want %+v", sent, want)
	}
	// Nothing piped in (someone typing the command): the session's.
	if sent = runLegacyState(t, nil, "working", "--agent", "claude"); sent != want {
		t.Fatalf("no input: %+v", sent)
	}
}

// A sub-agent's permission prompt shows in the lead's terminal, which waits for the developer: the lead is busy.
func TestLegacyWaitingHookOfASubagentIsTheSessions(t *testing.T) {
	sent := runLegacyState(t, input(legacySubQuestion), "waiting", "--agent", "claude", "--stdin")
	want := AgentStateRequest{BlockId: "block-1", State: "waiting", Agent: "claude", Message: "Claude needs your permission"}
	if sent != want {
		t.Fatalf("sent %+v, want %+v", sent, want)
	}
}

// Only a working report reads an input --stdin did not ask for: a done or a waiting one leaves stdin alone.
func TestLegacyReportReadsStdinOnlyForWorking(t *testing.T) {
	for _, state := range []string{"done", "waiting", "idle", "error"} {
		sent := runLegacyState(t, failingReader{t: t, state: state}, state, "--agent", "claude")
		if sent.State != state || sent.Subagent != "" {
			t.Errorf("%s: %+v", state, sent)
		}
	}
}

type failingReader struct {
	t     *testing.T
	state string
}

func (f failingReader) Read(p []byte) (int, error) {
	f.t.Errorf("%s: stdin read without --stdin", f.state)
	return 0, io.EOF
}

// A pipe nobody closes (a caller that leaves its own stdin open) does not hold the report: it goes as the session's.
func TestLegacyWorkingHookDoesNotWaitForAnOpenPipe(t *testing.T) {
	saved := pipedInputWait
	t.Cleanup(func() { pipedInputWait = saved })
	pipedInputWait = 10 * time.Millisecond
	r, w := io.Pipe()
	t.Cleanup(func() { w.Close() })
	sent := runLegacyState(t, r, "working", "--agent", "claude")
	if sent.State != "working" || sent.Subagent != "" {
		t.Fatalf("sent %+v", sent)
	}
}
