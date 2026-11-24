// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

// What an agent's sub-agents work on (#2502, FR-SHELL-018, FR-SHELL-084, FR-BOSS-009 AC85): the one fact the agent
// states, the companion and the activity popover share. wavesrv's companion reads it from the sub-agents' own files;
// pkg/molten/subagentwork keeps it per agent terminal, and the agent states publish it with the agent's state.

// The kinds of background job a sub-agent's command is named by. A window words each under activity.job.<kind>;
// JobCommand is any command the classifier does not know. Must match frontend/moltenterm-shell/activity/activity-model.ts.
const (
	JobVitest        = "vitest"
	JobGoTest        = "gotest"
	JobTests         = "tests"
	JobAffected      = "affected"
	JobBuildFrontend = "buildfrontend"
	JobBuildBackend  = "buildbackend"
	JobBuild         = "build"
	JobPerf          = "perf"
	JobCheck         = "check"
	JobNpmRun        = "npmrun"
	JobMoltenCi      = "moltenci"
	JobCommand       = "command"
)

// BackgroundJob is a command a sub-agent left running in the background, or a monitor it armed, that has not reported
// its end. Kind names it in plain words; Arg is the one word a kind may carry (the npm script's name); the command
// line itself is never kept. Since: when it started, in Unix milliseconds, 0 when unknown.
type BackgroundJob struct {
	Kind  string `json:"kind"`
	Arg   string `json:"arg,omitempty"`
	Since int64  `json:"since,omitempty"`
}

// SubagentWork is a sub-agent of an agent's session that works now: it runs, or its turn ended on background work of
// its own (Waiting) and it resumes when that work reports. Description is the task as its call gave it ("#2496 ..."),
// Kind its type ("sf-build"), Started when its transcript began (Unix milliseconds, 0 when unknown).
type SubagentWork struct {
	Id          string          `json:"id"`
	Description string          `json:"description,omitempty"`
	Kind        string          `json:"kind,omitempty"`
	Started     int64           `json:"started,omitempty"`
	Waiting     bool            `json:"waiting,omitempty"`
	Jobs        []BackgroundJob `json:"jobs,omitempty"`
}

// MaxSubagentWork bounds what one agent terminal carries.
const MaxSubagentWork = 12
