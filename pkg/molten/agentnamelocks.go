// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

// First names locked for a project (FR-CONT-014, DS-CONT-028, #2324). The windows lock and unlock through plain
// commands of the agent states route (pkg/molten/attention/agentroute.go), answered to windows only: an agent never
// reserves a name.
//
// must match frontend/moltenterm-shell/agent-name-locks-store.ts
const (
	// AgentNameLocksCommand lists the locks, in locking order.
	AgentNameLocksCommand = "moltenagentnamelocks"
	// AgentNameLockCommand locks the first name a terminal's agent holds for that agent's project.
	AgentNameLockCommand = "moltenagentnamelock"
	// AgentNameUnlockCommand frees a locked name.
	AgentNameUnlockCommand = "moltenagentnameunlock"
	// AgentNameLocksEvent tells the windows the list of locks changed.
	AgentNameLocksEvent = "molten:agentnamelocks"
)

// The outcomes of locking a name (AgentNameLockResult.Status).
const (
	AgentNameLockDone = "locked"
	// Already: the name is already locked for this project; nothing changed.
	AgentNameLockAlready = "already"
	// Elsewhere: the name is locked for another project (From) and the request did not ask to move it.
	AgentNameLockElsewhere = "elsewhere"
	// NoAgent: the terminal holds no agent with a first name.
	AgentNameLockNoAgent = "noagent"
	// NoProject: the agent's terminal is in no project folder, so there is nothing to lock the name for.
	AgentNameLockNoProject = "noproject"
	// NotLockable: the name is a numbered one ("Alice 2"), given when the list of names ran out.
	AgentNameLockNotLockable = "notlockable"
	// Failed: the lock could not be kept in MoltenTerm's data, so it was not applied.
	AgentNameLockFailed = "failed"
)

// The outcomes of unlocking a name (AgentNameUnlockResult.Status).
const (
	AgentNameUnlockDone   = "unlocked"
	AgentNameUnlockNone   = "none"
	AgentNameUnlockFailed = "failed"
)

// AgentNameLock is a first name reserved for a project: Project is the project's folder, the key the lock is kept
// under.
type AgentNameLock struct {
	Name    string `json:"name"`
	Project string `json:"project"`
}

type AgentNameLocksResult struct {
	// Locks: every lock, in the order they were made; a project's names are used in that order.
	Locks []AgentNameLock `json:"locks"`
}

// AgentNameLockRequest locks the name of the agent in BlockId. Name and project are the ones wavesrv holds for that
// agent, never the caller's. Move: take the name from the project it is locked for.
type AgentNameLockRequest struct {
	BlockId string `json:"blockid"`
	Move    bool   `json:"move,omitempty"`
}

type AgentNameLockResult struct {
	Status  string `json:"status"`
	Name    string `json:"name,omitempty"`
	Project string `json:"project,omitempty"`
	// From: the project the name is locked for, with Status elsewhere, or the one it was moved from.
	From string `json:"from,omitempty"`
}

type AgentNameUnlockRequest struct {
	Name string `json:"name"`
}

type AgentNameUnlockResult struct {
	Status string `json:"status"`
	Name   string `json:"name,omitempty"`
}
