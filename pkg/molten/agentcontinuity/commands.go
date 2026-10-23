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
	ActionEffort         = "effort"
	ActionResume         = "resume"
	ActionCopy           = "copy"
	ActionStatus         = "status"
	ActionReview         = "review"
	ActionPermissions    = "permissions"
	ActionFork           = "fork"
	ActionRename         = "rename"
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
	// CommandEffort: an effort level (#549). With a Text, the slash command the level follows (Ctrl+U, the text and
	// the level, Enter); without, the agent's effort keys, KeyLower and KeyRaise, one press per level.
	CommandEffort = "effort"
)

const (
	keyShiftTab = "\x1b[Z"
	keyEscape   = "\x1b"
	// Codex's default effort shortcuts besides Alt+, and Alt+. (tui/src/keymap.rs): Shift+Down and Shift+Up, CSI
	// sequences that an Escape read alone can never cut short.
	keyShiftDown = "\x1b[1;2B"
	keyShiftUp   = "\x1b[1;2A"
)

// AgentCommand is one row of an agent's table.
type AgentCommand struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	// Text: the slash command, or the raw key of a key, mode or interrupt command.
	Text string `json:"text"`
	// KeyLower, KeyRaise: an effort command's keys when it has no Text.
	KeyLower string `json:"keylower,omitempty"`
	KeyRaise string `json:"keyraise,omitempty"`
	// TakesModel: the slash command also takes one of ModelAliases after its text (Claude Code's `/model <alias>`,
	// #573), checked against that list, never free text.
	TakesModel bool `json:"takesmodel,omitempty"`
}

// ClearsLine tells whether the command empties the input line first, which loses an unsent draft.
func (c AgentCommand) ClearsLine() bool {
	return c.Kind == CommandSlash || (c.Kind == CommandEffort && c.Text != "")
}

var claudeCommands = []AgentCommand{
	{Action: ActionPermissionMode, Kind: CommandMode, Text: keyShiftTab},
	{Action: ActionClear, Kind: CommandSlash, Text: "/clear"},
	{Action: ActionCompact, Kind: CommandSlash, Text: "/compact"},
	{Action: ActionModel, Kind: CommandSlash, Text: "/model", TakesModel: true},
	{Action: ActionEffort, Kind: CommandEffort, Text: "/effort"},
	{Action: ActionResume, Kind: CommandSlash, Text: "/resume"},
	{Action: ActionCopy, Kind: CommandSlash, Text: "/copy"},
	{Action: ActionStatus, Kind: CommandSlash, Text: "/status"},
	{Action: ActionReview, Kind: CommandSlash, Text: "/review"},
	{Action: ActionInterrupt, Kind: CommandInterrupt, Text: keyEscape},
	{Action: ActionQuit, Kind: CommandSlash, Text: claudeExitCommand},
}

// Codex's table, read on codex-cli 0.163.0 (testdata/codex-0.163.0-slash-commands.txt, #990): /permissions replaced
// /approvals; /clear also clears the terminal view, /new does not.
var codexCommands = []AgentCommand{
	{Action: ActionPermissions, Kind: CommandSlash, Text: "/permissions"},
	{Action: ActionNew, Kind: CommandSlash, Text: "/new"},
	{Action: ActionClear, Kind: CommandSlash, Text: "/clear"},
	{Action: ActionCompact, Kind: CommandSlash, Text: "/compact"},
	{Action: ActionModel, Kind: CommandSlash, Text: "/model"},
	{Action: ActionEffort, Kind: CommandEffort, KeyLower: keyShiftDown, KeyRaise: keyShiftUp},
	{Action: ActionResume, Kind: CommandSlash, Text: "/resume"},
	{Action: ActionFork, Kind: CommandSlash, Text: "/fork"},
	{Action: ActionRename, Kind: CommandSlash, Text: "/rename"},
	{Action: ActionCopy, Kind: CommandSlash, Text: "/copy"},
	{Action: ActionStatus, Kind: CommandSlash, Text: "/status"},
	{Action: ActionReview, Kind: CommandSlash, Text: "/review"},
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

// ModelAliases lists the models an agent's model command takes inline (#573): Claude Code's launch aliases, which
// `/model <alias>` also takes (claude --help and the /model argument hint, 2.1.296), without the agent's default;
// nil for an agent whose model command is a picker only (Codex's /model takes no argument).
func ModelAliases(agent string) []ModelChoice {
	cmd, ok := FindAgentCommand(agent, ActionModel)
	if !ok || !cmd.TakesModel || agent != molten.AgentIdClaude {
		return nil
	}
	var rtn []ModelChoice
	for _, m := range claudeModels {
		if m.Id != "" {
			rtn = append(rtn, m)
		}
	}
	return rtn
}

// ModelAlias looks a model up in an agent's ModelAliases.
func ModelAlias(agent string, model string) (ModelChoice, bool) {
	for _, m := range ModelAliases(agent) {
		if m.Id == model {
			return m, true
		}
	}
	return ModelChoice{}, false
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
