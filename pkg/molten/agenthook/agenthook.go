// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agenthook is the cheap path of the agents' hooks (FR-PERF-012, DS-PERF-011). Claude Code's hooks run
// `molten agent state` after every tool call and its status line runs `molten agent statusline` after every message:
// up to one process a second per busy agent. wsh links nearly all of MoltenTerm, and starting it costs more than the
// hook's work, so `molten` is a small program of its own (cmd/molten) that runs these two commands with this package
// and hands every other command to wsh. wsh runs them with this package too.
//
// This package imports the standard library only: whatever it imports, every hook run starts.
package agenthook

// must match pkg/molten (checked by its tests)
const (
	AgentStatesRoute       = "molten:agents"
	AgentStateSetCommand   = "moltenagentstateset"
	CompanionRoute         = "molten:companion"
	AgentStatusLineCommand = "moltenagentstatusline"

	AgentStateWorking = "working"
	AgentStateWaiting = "waiting"
	AgentStateDone    = "done"
	AgentStateError   = "error"
	AgentStateIdle    = "idle"

	agentIdMaxLength = 32
)

// AgentStateRequest is molten.AgentStateRequest, as `molten agent state` and `molten agent hook` send it
// (FR-SHELL-011).
type AgentStateRequest struct {
	BlockId string `json:"blockid"`
	State   string `json:"state"`
	Agent   string `json:"agent,omitempty"`
	Message string `json:"message,omitempty"`
	TurnEnd bool   `json:"turnend,omitempty"`
	Start   bool   `json:"start,omitempty"`
}

// ValidAgentState and ValidAgentId accept what molten.ValidAgentState and molten.ValidAgentId accept, without a
// regular expression to compile at start.
func ValidAgentState(state string) bool {
	switch state {
	case AgentStateWorking, AgentStateWaiting, AgentStateDone, AgentStateError, AgentStateIdle:
		return true
	}
	return false
}

// ValidAgentId: lowercase letters, digits and dashes, not starting with a dash, at most 32 bytes.
func ValidAgentId(id string) bool {
	if id == "" || len(id) > agentIdMaxLength || id[0] == '-' {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}
