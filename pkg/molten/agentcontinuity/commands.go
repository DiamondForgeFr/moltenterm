// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import "github.com/wavetermdev/waveterm/pkg/molten"

// Agent command tables (FR-SHELL-048, DS-SHELL-088): the commands the command panel's Agent section may type into a
// coding agent. moltenagentinput accepts only an action of the running agent's table, never free text
// (NFR-SHELL-030). The tables are checked against the agents' versions at release time: a command an agent version
// removes is dropped from its table, never sent blind.

// must match frontend/moltenterm-shell/command-panel/agent-commands.ts
const (
	ActionPermissionMode = "permissionmode"
	ActionClear          = "clear"
	ActionNew            = "new"
	ActionCompact        = "compact"
	ActionModel          = "model"
	ActionResume         = "resume"
	ActionCopy           = "copy"
	ActionStatus         = "status"
	ActionReview         = "review"
	ActionApprovals      = "approvals"
	ActionDiff           = "diff"
	ActionInterrupt      = "interrupt"
	ActionQuit           = "quit"
)

// How a command is typed.
const (
	// CommandSlash: Ctrl+U, the text, Enter (the input line must be empty, so a possible draft is cleared first).
	CommandSlash = "slash"
	// CommandKey: one key, the input line untouched.
	CommandKey = "key"
	// CommandMode: one key per step towards a permission mode (Shift+Tab).
	CommandMode = "mode"
	// CommandInterrupt: the agent's interrupt key, the only command sent while the agent works.
	CommandInterrupt = "interrupt"
)

const (
	keyShiftTab = "\x1b[Z"
	keyEscape   = "\x1b"
)

// AgentCommand is one row of an agent's table.
type AgentCommand struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	// Text: the slash command, or the raw key of a key, mode or interrupt command.
	Text string `json:"text"`
}

// ClearsLine tells whether the command empties the input line first, which loses an unsent draft.
func (c AgentCommand) ClearsLine() bool {
	return c.Kind == CommandSlash
}

var claudeCommands = []AgentCommand{
	{Action: ActionPermissionMode, Kind: CommandMode, Text: keyShiftTab},
	{Action: ActionClear, Kind: CommandSlash, Text: "/clear"},
	{Action: ActionCompact, Kind: CommandSlash, Text: "/compact"},
	{Action: ActionModel, Kind: CommandSlash, Text: "/model"},
	{Action: ActionResume, Kind: CommandSlash, Text: "/resume"},
	{Action: ActionCopy, Kind: CommandSlash, Text: "/copy"},
	{Action: ActionStatus, Kind: CommandSlash, Text: "/status"},
	{Action: ActionReview, Kind: CommandSlash, Text: "/review"},
	{Action: ActionInterrupt, Kind: CommandInterrupt, Text: keyEscape},
	{Action: ActionQuit, Kind: CommandSlash, Text: claudeExitCommand},
}

var codexCommands = []AgentCommand{
	{Action: ActionApprovals, Kind: CommandSlash, Text: "/approvals"},
	{Action: ActionNew, Kind: CommandSlash, Text: "/new"},
	{Action: ActionCompact, Kind: CommandSlash, Text: "/compact"},
	{Action: ActionModel, Kind: CommandSlash, Text: "/model"},
	{Action: ActionStatus, Kind: CommandSlash, Text: "/status"},
	{Action: ActionDiff, Kind: CommandSlash, Text: "/diff"},
	{Action: ActionInterrupt, Kind: CommandInterrupt, Text: keyEscape},
	{Action: ActionQuit, Kind: CommandSlash, Text: codexExitCommand},
}

// AgentCommands is an agent's table, nil for an agent without one.
func AgentCommands(agent string) []AgentCommand {
	switch agent {
	case molten.AgentIdClaude:
		return claudeCommands
	case molten.AgentIdCodex:
		return codexCommands
	}
	return nil
}

// FindAgentCommand looks an action up in an agent's table.
func FindAgentCommand(agent string, action string) (AgentCommand, bool) {
	for _, c := range AgentCommands(agent) {
		if c.Action == action {
			return c, true
		}
	}
	return AgentCommand{}, false
}
