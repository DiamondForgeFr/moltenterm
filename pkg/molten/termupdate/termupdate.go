// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package termupdate finds the terminals still running with an older MoltenTerm shell environment and brings them up
// to date in one action (FR-SHELL-041). Durable local shells outlive MoltenTerm's updates (FR-SHELL-020), so a shell
// keeps what the build that started it set up: a shell from before FR-SHELL-036 has no agent launchers on PATH, and an
// agent started there runs without MoltenTerm's browser or hooks.
//
// Detection (DS-SHELL-073): each local shell job records the shell generation it got (shellutil.MoltenShellGeneration,
// in its environment at start); the refresh hook of later shells reports the generation it applied (job meta).
// Update terminal (DS-SHELL-075): an idle shell is replaced in place; an idle coding agent is ended with its own exit
// command and started again on its session in a fresh shell; anything else is left alone and named.
package termupdate

import (
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// must match frontend/moltenterm-shell/termupdate/termupdate-model.ts
const (
	Route = "molten:termupdate"
	Event = "molten:termupdate"

	ListCommand  = "moltentermupdatelist"
	CheckCommand = "moltentermupdatecheck"
	RunCommand   = "moltentermupdaterun"

	// Job meta: the generation the shell's refresh hook last reported, and when it rose to it (Unix ms).
	ShellGenMetaKey   = "molten:shellgen"
	ShellGenAtMetaKey = "molten:shellgents"

	// Why a terminal is outdated.
	ReasonNoGeneration       = "nogeneration"
	ReasonOlderGeneration    = "oldergeneration"
	ReasonAgentBeforeRefresh = "agentbeforerefresh"

	// What Update terminal finds, or did.
	StatusReady       = "ready"
	StatusNeedConfirm = "needconfirm"
	StatusBusy        = "busy"
	StatusAgentBusy   = "agentbusy"
	StatusAgentStuck  = "agentstuck"
	StatusUpdated     = "updated"
	StatusUnavailable = "unavailable"
	StatusFailed      = "failed"
)

// OutdatedTerminal is one terminal whose shell environment is older than MoltenTerm's.
type OutdatedTerminal struct {
	BlockId    string `json:"blockid"`
	Reason     string `json:"reason"`
	Generation int    `json:"generation"`
	Current    int    `json:"current"`
	// Agent: the coding agent running in it, started with the older environment.
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
}

type OutdatedData struct {
	Terminals []OutdatedTerminal `json:"terminals"`
	Version   int64              `json:"version"`
}

type Request struct {
	BlockId string `json:"blockid"`
	// Confirmed: the user agreed to restart the agent running in the terminal.
	Confirmed bool `json:"confirmed,omitempty"`
}

// Outcome is what Update terminal found (check) or did (run).
type Outcome struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	// Agent: the coding agent the terminal runs (needconfirm, agentbusy, agentstuck, updated).
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	// Program: what keeps the terminal busy.
	Program string `json:"program,omitempty"`
	// Command: what was typed in the new shell to start the agent again.
	Command string `json:"command,omitempty"`
	// Guessed: the agent's session was not known for sure, so its most recent one was reopened.
	Guessed bool `json:"guessed,omitempty"`
}

// ShellGeneration reads what a job knows of its shell's generation: the one it started with (0 before generations
// existed), the one its refresh hook reported last (0: never) and when that one was reached (Unix ms, 0: unknown).
func ShellGeneration(job *waveobj.Job) (start int, reported int, reportedAt int64) {
	if job == nil {
		return 0, 0, 0
	}
	start, _ = strconv.Atoi(job.CmdEnv[shellutil.MoltenShellGenVarName])
	reported = metaInt(job.Meta, ShellGenMetaKey)
	reportedAt = int64(metaInt(job.Meta, ShellGenAtMetaKey))
	return start, reported, reportedAt
}

// Meta values come back from the store's JSON as float64.
func metaInt(meta waveobj.MetaMapType, key string) int {
	switch v := meta[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	}
	return 0
}

// IsLocalShellJob: a live interactive shell on this machine, attached to a terminal. Commands of a block (isCommand)
// get no shell environment from MoltenTerm and are never outdated.
func IsLocalShellJob(job *waveobj.Job, isCommand bool) bool {
	if job == nil || isCommand || job.AttachedBlockId == "" || job.CmdExitTs > 0 || job.CmdPid <= 0 {
		return false
	}
	if job.JobKind != "" && job.JobKind != "shell" {
		return false
	}
	return conncontroller.IsLocalConnName(job.Connection)
}

// Assess tells whether a terminal's shell environment is older than current (DS-SHELL-073). run is the agent the
// states know in the terminal, if any.
func Assess(job *waveobj.Job, isCommand bool, run molten.AgentRunInfo, hasRun bool, current int) (OutdatedTerminal, bool) {
	if !IsLocalShellJob(job, isCommand) {
		return OutdatedTerminal{}, false
	}
	start, reported, reportedAt := ShellGeneration(job)
	gen := max(start, reported)
	agentRuns := hasRun && run.Running && run.Agent != ""
	rtn := OutdatedTerminal{BlockId: job.AttachedBlockId, Generation: gen, Current: current}
	if agentRuns {
		rtn.Agent = run.Agent
		rtn.AgentName = molten.AgentDisplayName(run.Agent)
	}
	if gen >= current {
		// The shell caught up through its refresh hook: an agent it started before that still runs with the old
		// environment.
		if agentRuns && start < current && (reportedAt <= 0 || run.Started < reportedAt) {
			rtn.Reason = ReasonAgentBeforeRefresh
			return rtn, true
		}
		return OutdatedTerminal{}, false
	}
	// A shell whose refresh hook reported once catches up at its next prompt or command: only an agent already
	// running in it is outdated.
	if reported > 0 && !agentRuns {
		return OutdatedTerminal{}, false
	}
	if gen == 0 {
		rtn.Reason = ReasonNoGeneration
	} else {
		rtn.Reason = ReasonOlderGeneration
	}
	return rtn, true
}
