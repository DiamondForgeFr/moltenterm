// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"strings"
	"testing"
)

// Inputs shaped as Claude Code sends them to a Notification hook (https://code.claude.com/docs/en/hooks).
func notificationInput(notificationType string, message string) string {
	typeField := ""
	if notificationType != "" {
		typeField = `,"notification_type":"` + notificationType + `"`
	}
	return `{"session_id":"abc123","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"Notification",` +
		`"message":"` + message + `","title":"Claude Code"` + typeField + `}`
}

// #784: a Notification waits only for the types that ask the user something; the idle reminder after a finished turn
// and the others leave the state as it is.
func TestStateReportClassifiesNotifications(t *testing.T) {
	cases := []struct {
		name, input string
		send        bool
	}{
		{"permission", notificationInput("permission_prompt", "Claude needs your permission to use Bash"), true},
		{"question", notificationInput("elicitation_dialog", "MCP server needs input"), true},
		{"url question", notificationInput("elicitation_url_dialog", "Open this page"), true},
		{"background session", notificationInput("agent_needs_input", "A session waits"), true},
		{"limit reset after sleep", notificationInput("quota_auto_resume_stale", "Press Enter to continue"), true},
		{"idle reminder", notificationInput("idle_prompt", "Claude is waiting for your input"), false},
		{"login", notificationInput("auth_success", "Logged in"), false},
		{"background done", notificationInput("agent_completed", "Session finished"), false},
		{"limit resumed", notificationInput("quota_auto_resume_fired", "Continuing"), false},
		{"unknown type", notificationInput("something_new", "Claude needs your permission"), false},
		{"no type, idle text", notificationInput("", "Claude is waiting for your input"), false},
		{"no type, permission text", notificationInput("", "Claude needs your permission to use Bash"), true},
		{"no input", "", true},
		{"not json", "hello", true},
		{"another event", `{"hook_event_name":"Stop","notification_type":"idle_prompt"}`, true},
	}
	for _, c := range cases {
		_, send := StateReport(AgentStateWaiting, "", strings.NewReader(c.input))
		if send != c.send {
			t.Errorf("%s: send %v, want %v", c.name, send, c.send)
		}
	}
}

func TestStateReportMessage(t *testing.T) {
	input := notificationInput("permission_prompt", "Claude needs your permission to use Bash")
	if msg, send := StateReport(AgentStateWaiting, "", strings.NewReader(input)); !send || msg != "Claude needs your permission to use Bash" {
		t.Errorf("message from the input: %q %v", msg, send)
	}
	if msg, _ := StateReport(AgentStateWaiting, "mine", strings.NewReader(input)); msg != "mine" {
		t.Errorf("--message wins: %q", msg)
	}
	// Only a waiting report is sorted: done with the idle input is still done.
	idle := notificationInput("idle_prompt", "Claude is waiting for your input")
	if _, send := StateReport(AgentStateDone, "", strings.NewReader(idle)); !send {
		t.Error("done is always sent")
	}
}

func TestWaitingMatcherIsAListOfTypes(t *testing.T) {
	for _, typ := range strings.Split(ClaudeWaitingNotificationMatcher, "|") {
		if typ == "" || strings.Trim(typ, "abcdefghijklmnopqrstuvwxyz_") != "" {
			t.Errorf("%q: Claude Code matches only letters, digits, _ and | as exact types", typ)
		}
	}
	if strings.Contains(ClaudeWaitingNotificationMatcher, "idle_prompt") {
		t.Error("idle_prompt must not wait")
	}
}

// The small program reports nothing for the idle reminder: no connection to wavesrv at all.
func TestRunFastSkipsIdleReminder(t *testing.T) {
	s := startFakeServer(t, "")
	token := testToken(s.sock, "block-1")
	s.token = token
	env, _, stderr := envFrom(map[string]string{jwtVarName: token}, notificationInput("idle_prompt", "Claude is waiting for your input"))
	handled, code := RunFast([]string{"agent", "state", "waiting", "--agent", "claude", "--stdin"}, env)
	if !handled || code != 0 || stderr.Len() != 0 {
		t.Fatalf("handled %v code %d err %q", handled, code, stderr)
	}
	if n := s.connections(); n != 0 {
		t.Errorf("%d connections for the idle reminder", n)
	}
}
