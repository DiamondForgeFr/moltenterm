// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"io"
	"strings"
)

// Claude Code's Notification hook does not only fire when the agent needs an answer (#784). Its input names the
// notification_type (https://code.claude.com/docs/en/hooks, "Notification"): idle_prompt fires about a minute after a
// turn ended ("Claude is waiting for your input"), others after an authentication, a completed elicitation or a usage
// limit resume. Reported as waiting, a finished agent turned amber a minute after it turned green. Hooks pasted before
// the matcher existed run for every type, so `molten agent state waiting --stdin` sorts them itself.

// ClaudeWaitingNotificationMatcher scopes the Notification hook of agent-states.md to the types that wait for the user
// (ClaudeNotificationWaits). Claude Code matches it as a list of exact types.
const ClaudeWaitingNotificationMatcher = "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|quota_auto_resume_stale"

const notificationHookEvent = "Notification"

// claudeIdleWords: the idle_prompt text, which an older Claude Code sends without a notification_type, and which its
// terminal notifications (OSC 9, OSC 777) carry too.
const claudeIdleWords = "waiting for your input"

// HookInput is what `molten agent state --stdin` and `molten agent hook` read of a hook's JSON input (ReadHookInput,
// hook.go): the fields Claude Code and Codex share, and Claude Code's Notification fields.
type HookInput struct {
	HookEventName       string `json:"hook_event_name"`
	NotificationType    string `json:"notification_type"`
	Message             string `json:"message"`
	SessionId           string `json:"session_id"`
	TranscriptPath      string `json:"transcript_path"`
	Source              string `json:"source"`
	AgentId             string `json:"agent_id"`
	AgentType           string `json:"agent_type"`
	AgentTranscriptPath string `json:"agent_transcript_path"`
}

// IsIdlePromptMessage tells whether a notification's text is Claude Code's "waiting for your input" after a finished
// turn, which asks nothing.
func IsIdlePromptMessage(message string) bool {
	return strings.Contains(strings.ToLower(message), claudeIdleWords)
}

// ClaudeNotificationWaits tells whether a hook input means the agent waits for the user. Anything but a Notification
// does (what the hook was set up for). A Notification waits for the types of ClaudeWaitingNotificationMatcher; without
// a type (an older Claude Code), unless its text is the idle one. Other and unknown types change nothing.
func ClaudeNotificationWaits(input HookInput) bool {
	if input.HookEventName != "" && input.HookEventName != notificationHookEvent {
		return true
	}
	if input.NotificationType == "" {
		return !IsIdlePromptMessage(input.Message)
	}
	for _, t := range strings.Split(ClaudeWaitingNotificationMatcher, "|") {
		if input.NotificationType == t {
			return true
		}
	}
	return false
}

// StateReport applies --stdin to a report of `molten agent state`: the message the input gives when --message did
// not, and send false for a waiting report from a notification that waits for nothing (the state stays as it is).
func StateReport(state string, message string, stdin io.Reader) (string, bool) {
	input := ReadHookInput(stdin)
	if message == "" {
		message = input.Message
	}
	if state == AgentStateWaiting && !ClaudeNotificationWaits(input) {
		return message, false
	}
	return message, true
}
