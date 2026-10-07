// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentlaunch starts coding agents with MoltenTerm's integration for one run (FR-SHELL-036, DS-SHELL-044 to
// 048, FR-SHELL-038 for Codex). In a local MoltenTerm terminal, `claude` and `codex` are launchers placed first on
// PATH (links to wsh in
// <data>/bin/agents/); it finds the real binary, asks the agent's adapter what to add through the agent's documented
// per-run mechanism, and replaces itself with the real binary. Nothing of the user's is written (NFR-SHELL-019): the
// adapters only read the agent's configuration, and what they add lives in MoltenTerm's data folder.
//
// Adding an agent means adding an adapter here and its launcher link (shellutil.InstallMoltenCommand).
package agentlaunch

import (
	"sort"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

const (
	// The launchers' folder, set by the shell integration scripts, which put it first on PATH after the user's
	// startup files.
	AgentBinDirVarName = "MOLTENTERM_AGENTBINDIR"
	// Set for an integrated agent and so for every process it starts: a nested run of an agent adds nothing.
	LaunchedVarName = "MOLTENTERM_AGENT_LAUNCHED"
	// MOLTENTERM_AGENT_INTEGRATION=0 turns the integration off for one command.
	IntegrationVarName = "MOLTENTERM_AGENT_INTEGRATION"
	// The launchers' folder, under the wsh bin folder.
	AgentBinDirName = shellutil.AgentBinDirName
)

// LaunchContext is what an adapter plans from: the user's arguments unchanged, the environment and folder the agent
// starts with, and the pane.
type LaunchContext struct {
	Args    []string
	Env     molten.AgentEnv
	Cwd     string
	BlockId string
	// ManagedSettings: Claude Code's managed settings file, "" for the system's (tests set their own).
	ManagedSettings string
	// CodexSystemConfig: Codex's system config.toml, "" for /etc/codex's (tests set their own).
	CodexSystemConfig string
	// MoltenPath: the absolute path of MoltenTerm's molten (MoltenPath), "" when it is not installed.
	MoltenPath string
}

// What a planned file is, for the report.
const (
	FileSettings  = "settings"
	FileMcpConfig = "mcpconfig"
)

// PlannedFile is a file the run needs, written content-addressed in MoltenTerm's data folder (files.go).
type PlannedFile struct {
	Kind   string
	Prefix string
	Data   []byte
}

// LaunchPlan is what an adapter adds to one run. StepAside: nothing is added, and why (the report says it).
type LaunchPlan struct {
	Files []PlannedFile
	// MakeArgs builds the real binary's arguments from the written files' paths, in Files' order.
	MakeArgs  func(paths []string) []string
	Added     []molten.IntegrationItem
	Skipped   []molten.IntegrationItem
	StepAside string
}

// LaunchAdapter integrates one agent at launch.
type LaunchAdapter interface {
	// Id is the agent id of molten.AgentKinds.
	Id() string
	// Executable is the program name the launcher is installed under.
	Executable() string
	// PassThrough tells whether the arguments run a command that starts no session (--version, a management
	// subcommand): the real binary then runs with nothing added.
	PassThrough(args []string) bool
	Plan(ctx LaunchContext) (LaunchPlan, error)
}

var adapters = map[string]LaunchAdapter{
	ClaudeAgentId: claudeAdapter{},
	CodexAgentId:  codexAdapter{},
}

// FindAdapter returns the adapter of an agent id, or nil.
func FindAdapter(id string) LaunchAdapter {
	return adapters[id]
}

// AdapterForProgram returns the adapter whose launcher has this program name (without .exe), or nil.
func AdapterForProgram(name string) LaunchAdapter {
	for _, a := range adapters {
		if a.Executable() == name {
			return a
		}
	}
	return nil
}

// LauncherNames lists the program names of every launcher, sorted.
func LauncherNames() []string {
	var rtn []string
	for _, a := range adapters {
		rtn = append(rtn, a.Executable())
	}
	sort.Strings(rtn)
	return rtn
}
