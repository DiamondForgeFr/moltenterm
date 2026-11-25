// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"io"
	"os"
	"time"
)

// A sub-agent's report through `molten agent state` (#2536). Claude Code runs a session's hooks inside its sub-agents
// too, with the sub-agent's agent_id in the hook's input. The hooks pasted from an earlier agent-states.md run
// `molten agent state working --agent claude` on PostToolUse, without --stdin: every tool of a background sub-agent
// then reported the lead's own session working, long after its turn ended. A lead waiting at its prompt read busy, and
// handoffs, page comments and agents' messages were queued until it took another turn.
//
// So a working report reads the hook's input even without --stdin, when one is piped in: an input that names a
// sub-agent reports that sub-agent, as `molten agent hook` does (RunHookEvent). A terminal on stdin (someone typing the
// command) is never read, and a pipe that is not closed in time leaves the report as it was.

// pipedInputWait bounds the read of a hook's input that --stdin did not ask for: a hook's input is written at once and
// closed, a pipe left open by another caller must not hold the report. A test lowers it.
var pipedInputWait = 2 * time.Second

// StateRequestFrom reads what a report of `molten agent state` sends: its message (from the input with --stdin when
// --message gave none), the sub-agent it is about, and send false for a waiting report from a notification that waits
// for nothing (the state stays as it is).
func StateRequestFrom(state string, message string, readStdin bool, stdin io.Reader) (string, string, bool) {
	if readStdin {
		input := ReadHookInput(stdin)
		if message == "" {
			message = input.Message
		}
		if state == AgentStateWaiting && !ClaudeNotificationWaits(input) {
			return message, "", false
		}
		return message, reportedSubagent(state, input), true
	}
	if state != AgentStateWorking {
		return message, "", true
	}
	return message, reportedSubagent(state, pipedHookInput(stdin)), true
}

// reportedSubagent is the sub-agent a report is about. A sub-agent's question shows in the session's terminal, which
// waits for the developer: that waiting is the pane's.
func reportedSubagent(state string, input HookInput) string {
	if state == AgentStateWaiting {
		return ""
	}
	return input.AgentId
}

// pipedHookInput is the hook input piped on stdin, read within pipedInputWait; empty for a terminal or nothing in time.
// The reader keeps streaming (a PostToolUse input carries the tool's whole output), so nothing is held in memory.
func pipedHookInput(r io.Reader) HookInput {
	if r == nil {
		return HookInput{}
	}
	if f, ok := r.(*os.File); ok {
		st, err := f.Stat()
		if err != nil || st.Mode()&os.ModeCharDevice != 0 {
			return HookInput{}
		}
	}
	done := make(chan HookInput, 1)
	go func() {
		done <- ReadHookInput(r)
	}()
	timer := time.NewTimer(pipedInputWait)
	defer timer.Stop()
	select {
	case input := <-done:
		return input
	case <-timer.C:
		return HookInput{}
	}
}
