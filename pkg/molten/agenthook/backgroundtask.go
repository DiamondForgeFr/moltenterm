// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"bytes"
	"encoding/json"
	"io"
)

// Background commands (#2140, FR-CONT-015), Claude Code's adapter. A Bash call Claude Code runs in the background
// (run_in_background, or a foreground command moved there when it timed out) ends its PostToolUse with
// tool_response.backgroundTaskId; Claude Code may then end its turn and resumes the session by itself when the command
// ends. That end comes through no hook: Claude Code writes a task notification naming the id to the session's
// transcript, `<task-notification>\n<task-id>bz4ehrk6q</task-id>...<status>completed</status>...`, whatever the
// command's status (completed, failed, killed). Codex's commands never resume a session: it has no such report.
//
// A command the agent stops with its TaskStop tool writes no task notification (#2582, Claude Code 2.1.332): its end is
// only the tool's result, `{"message":"Successfully stopped task: bz4ehrk6q (sleep 600)","task_id":"bz4ehrk6q",
// "task_type":"local_bash","command":"sleep 600"}`, in the result line's toolUseResult and, JSON-quoted, in its
// tool_result. A stop that failed, or that the machine running the command did not confirm, words it otherwise.

const (
	taskIdOpen  = "<task-id>"
	taskIdClose = "</task-id>"
	// taskStoppedPrefix + id + taskStoppedSuffix: what a TaskStop that stopped the command answers.
	taskStoppedPrefix = "Successfully stopped task: "
	taskStoppedSuffix = " ("
	// BackgroundTaskIdMaxLength: longer ids are not Claude Code's (nine characters today).
	BackgroundTaskIdMaxLength = 128
	// TaskNotificationScanChunk: how much of a transcript TaskNotificationEnds reads at once.
	TaskNotificationScanChunk = 1024 * 1024
)

var backgroundTaskIdKey = []byte(`"backgroundTaskId"`)

// readToolField keeps what a PostToolUse's tool_input and tool_response tell of a background command. A tool's
// response is only decoded when it may carry the id.
func readToolField(input *HookInput, key string, raw json.RawMessage) {
	switch key {
	case "tool_input":
		var ti struct {
			Description string `json:"description"`
		}
		if json.Unmarshal(raw, &ti) == nil {
			input.ToolDescription = ti.Description
		}
		if len(raw) <= maxKeptToolInput {
			input.ToolInput = string(raw)
		}
	case "tool_response":
		if !bytes.Contains(raw, backgroundTaskIdKey) {
			return
		}
		var tr struct {
			BackgroundTaskId string `json:"backgroundTaskId"`
		}
		if json.Unmarshal(raw, &tr) == nil && len(tr.BackgroundTaskId) <= BackgroundTaskIdMaxLength {
			input.BackgroundTaskId = tr.BackgroundTaskId
		}
	}
}

// TaskNotificationEnds reads a transcript (from where the commands started) and returns the ids among ids that a task
// notification, or a TaskStop that stopped them, names: those commands ended. It reads in chunks that overlap by the
// longest marker, so a marker cut between two reads is still found; a read error ends the scan with what was found.
func TaskNotificationEnds(r io.Reader, ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	markers := make([][2][]byte, len(ids))
	overlap := 0
	for i, id := range ids {
		markers[i] = [2][]byte{[]byte(taskIdOpen + id + taskIdClose), []byte(taskStoppedPrefix + id + taskStoppedSuffix)}
		for _, m := range markers[i] {
			overlap = max(overlap, len(m)-1)
		}
	}
	found := make([]bool, len(ids))
	var ended []string
	buf := make([]byte, overlap+TaskNotificationScanChunk)
	kept := 0
	for {
		n, err := io.ReadFull(r, buf[kept:])
		data := buf[:kept+n]
		for i, m := range markers {
			if !found[i] && (bytes.Contains(data, m[0]) || bytes.Contains(data, m[1])) {
				found[i] = true
				ended = append(ended, ids[i])
			}
		}
		if err != nil || len(ended) == len(ids) {
			return ended
		}
		kept = min(overlap, len(data))
		copy(buf, data[len(data)-kept:])
	}
}
