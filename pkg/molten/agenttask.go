// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

// The workspace task checkpoint (FR-CONT-007, DS-CONT-008): wavesrv keeps one per workspace in its data folder
// (pkg/molten/agentcontinuity/checkpoint) and answers the windows and `molten task` through a leaf of its router.
// These names are shared with wsh.

// must match frontend/moltenterm-shell/companion/companion-task-model.ts
const (
	TaskRoute          = "molten:task"
	TaskEvent          = "molten:task"
	TaskReadCommand    = "moltentaskread"
	TaskHistoryCommand = "moltentaskhistory"
	TaskRestoreCommand = "moltentaskrestore"
	TaskClearCommand   = "moltentaskclear"
)

// TaskRequest names a workspace's checkpoint by the workspace, or by a block of it (a terminal's wsh sends its own).
// Section: one section only, for a read. N: a history version, 1 being the newest. Create: a read for editing writes
// an empty checkpoint first when there is none, so the editor opens a file.
type TaskRequest struct {
	BlockId     string `json:"blockid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Section     string `json:"section,omitempty"`
	N           int    `json:"n,omitempty"`
	Create      bool   `json:"create,omitempty"`
}

// TaskTranscript points at the last session the checkpoint was updated from (never its content).
type TaskTranscript struct {
	Agent   string `json:"agent,omitempty"`
	Session string `json:"session,omitempty"`
	Path    string `json:"path,omitempty"`
}

// TaskSection is one section of the checkpoint. Owner: auto, user, or <agent>:<session> for an agent.
type TaskSection struct {
	Name  string `json:"name"`
	Owner string `json:"owner,omitempty"`
	At    int64  `json:"at,omitempty"`
	Text  string `json:"text"`
	// Extra: a section the user added; the fixed ones come first, in their order.
	Extra bool `json:"extra,omitempty"`
}

// TaskView is what a read returns. Markdown is the whole file, secrets redacted.
type TaskView struct {
	WorkspaceId string          `json:"workspaceid"`
	Path        string          `json:"path"`
	Exists      bool            `json:"exists"`
	Started     int64           `json:"started,omitempty"`
	Updated     int64           `json:"updated,omitempty"`
	UpdatedBy   string          `json:"updatedby,omitempty"`
	Transcript  *TaskTranscript `json:"transcript,omitempty"`
	Redactions  int             `json:"redactions"`
	Versions    int             `json:"versions"`
	Sections    []TaskSection   `json:"sections,omitempty"`
	Markdown    string          `json:"markdown,omitempty"`
}

// TaskVersion is one version of the history, N 1 being the newest.
type TaskVersion struct {
	N         int    `json:"n"`
	At        int64  `json:"at"`
	UpdatedBy string `json:"updatedby,omitempty"`
	Goal      string `json:"goal,omitempty"`
	Size      int64  `json:"size"`
}

// TaskChanged is the event published, scoped to the workspace, after each write.
type TaskChanged struct {
	WorkspaceId string `json:"workspaceid"`
	Updated     int64  `json:"updated"`
	UpdatedBy   string `json:"updatedby,omitempty"`
}
