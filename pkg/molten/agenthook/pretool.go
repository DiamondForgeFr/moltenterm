// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"encoding/json"
	"regexp"
	"strings"
)

// A sub-agent's plan (#2585). `molten agent plan` finds its plan by the terminal it runs in, and a Claude Code
// sub-agent's shell is its lead's: same terminal, same environment (Claude Code 2.1.x builds every Bash call's
// environment from the session, the lead's, and the same AI_AGENT for the lead and its sub-agents). Only the hooks
// tell them apart: a hook fired inside a sub-agent carries its agent_id, the lead's carries none. So MoltenTerm's
// PreToolUse hook on Bash hands Claude Code the sub-agent's call back with `--subagent <agent_id>` after each
// `molten agent plan <op>` it runs (updatedInput): the call then works on the sub-agent's own plan, never the lead's.
// The lead's calls are left as they are. The flag goes after the operation, so a permission rule such as
// `Bash(molten agent plan set:*)` still matches the changed command.

const (
	HookEventPreToolUse = "PreToolUse"
	// ClaudeBashTool: the tool whose calls the hook changes.
	ClaudeBashTool = "Bash"
	// ClaudePlanHookIf narrows the hook to the calls that run the plan command (Claude Code's `if`, permission rule
	// syntax): a lead's other Bash calls start no process. It is best effort, so the handler checks the command itself.
	ClaudePlanHookIf = "Bash(molten agent plan *)"

	// must match agentplan.SubagentFlag
	planSubagentFlag = "--subagent"
	// must match agentplan.MaxSubagentId
	maxSubagentId = 128
	// A Bash call's input is small; a larger one is not handed back.
	maxKeptToolInput = 256 * 1024
)

// The plan command and its operation, if one follows (agentplan's operations).
var planCommandRegex = regexp.MustCompile(`\bmolten\s+agent\s+plan\b(?:\s+(?:set|start|done|add|clear|show)\b)?`)

// ValidSubagentId is agentplan.ValidSubagentId (the package imports the standard library only): the id is written into
// a shell command, so only letters, digits, dashes and underscores pass.
func ValidSubagentId(id string) bool {
	if id == "" || len(id) > maxSubagentId {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// SubagentPlanCommand adds `--subagent <id>` after each `molten agent plan <op>` of a command that does not name one
// yet; changed is false when there is none.
func SubagentPlanCommand(command string, agentId string) (string, bool) {
	if !ValidSubagentId(agentId) {
		return command, false
	}
	locs := planCommandRegex.FindAllStringIndex(command, -1)
	if len(locs) == 0 {
		return command, false
	}
	var b strings.Builder
	last, changed := 0, false
	for _, loc := range locs {
		b.WriteString(command[last:loc[1]])
		last = loc[1]
		if namesSubagent(command[loc[1]:]) {
			continue
		}
		b.WriteString(" " + planSubagentFlag + " " + agentId)
		changed = true
	}
	b.WriteString(command[last:])
	return b.String(), changed
}

// namesSubagent tells whether the words after a plan command already give --subagent.
func namesSubagent(rest string) bool {
	trimmed := strings.TrimLeft(rest, " \t")
	return strings.HasPrefix(trimmed, planSubagentFlag+" ") || strings.HasPrefix(trimmed, planSubagentFlag+"=")
}

// PreToolUseOutput is what the hook prints for a PreToolUse: the sub-agent's Bash call with its plan commands named
// after it, as Claude Code's hookSpecificOutput.updatedInput (the whole input, every other field as it came). No
// permissionDecision: the changed call goes through the user's permission rules as any other. ok is false, and the hook
// prints nothing, for the lead's calls and anything else.
func PreToolUseOutput(input HookInput) ([]byte, bool) {
	if input.HookEventName != HookEventPreToolUse || input.AgentId == "" || input.ToolName != ClaudeBashTool || len(input.ToolInput) == 0 {
		return nil, false
	}
	var toolInput map[string]json.RawMessage
	if json.Unmarshal([]byte(input.ToolInput), &toolInput) != nil {
		return nil, false
	}
	var command string
	if json.Unmarshal(toolInput["command"], &command) != nil {
		return nil, false
	}
	changed, ok := SubagentPlanCommand(command, input.AgentId)
	if !ok {
		return nil, false
	}
	raw, err := json.Marshal(changed)
	if err != nil {
		return nil, false
	}
	toolInput["command"] = raw
	out, err := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]any{"hookEventName": HookEventPreToolUse, "updatedInput": toolInput},
	})
	if err != nil {
		return nil, false
	}
	return out, true
}
