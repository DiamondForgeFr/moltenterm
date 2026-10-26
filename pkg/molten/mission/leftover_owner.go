// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// Who holds a leftover's worktree lock while its process runs (#1143, FR-REV-022 AC16). MoltenTerm never unlocks or
// removes such a worktree: Clean up asks its owner, so the owner is named the way the developer knows it. The lock's
// pid (with its start time, ParseLockReason) is matched against MoltenTerm's agent terminals: the agent whose process
// holds the lock or is one of its ancestors; for a sub-agent's worktree, the parent session that started it (Claude
// Code locks its sub-agents' worktrees with its own pid); else an agent terminal working in the worktree; else the
// process is named by its name and the folder it runs in, and nobody can be asked.

const (
	LeftoverLockLive = "live"

	OwnerViaAgent    = "agent"
	OwnerViaParent   = "parent"
	OwnerViaTerminal = "terminal"
	OwnerViaProcess  = "process"
)

// LeftoverOwner is the live holder of a leftover's worktree lock. BlockId: the terminal to ask and to go to, "" when
// MoltenTerm has none (OwnerViaProcess); Process and Folder: the process's name and folder, for that case.
type LeftoverOwner struct {
	Via       string `json:"via"`
	Pid       int32  `json:"pid"`
	BlockId   string `json:"blockid,omitempty"`
	FirstName string `json:"firstname,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Process   string `json:"process,omitempty"`
	Folder    string `json:"folder,omitempty"`
}

// Reachable: a MoltenTerm terminal runs the owner, so it can be asked.
func (o LeftoverOwner) Reachable() bool {
	return o.BlockId != "" && o.Via != OwnerViaProcess
}

// ProcFacts is what the owner's resolution reads of the process table; the tests give fakes.
type ProcFacts interface {
	// Under: pid is root or one of its descendants.
	Under(pid int32, root int32) bool
	Name(pid int32) string
	Cwd(pid int32) string
}

type liveProcs struct {
	table *proctree.Table
}

// LiveProcFacts reads the process table once; nil when it cannot be read.
func LiveProcFacts() ProcFacts {
	table, err := proctree.Read()
	if err != nil {
		return nil
	}
	return liveProcs{table: table}
}

func (p liveProcs) Under(pid int32, root int32) bool {
	return p.table.Under(pid, root)
}

func (p liveProcs) Name(pid int32) string {
	if proc := p.table.Get(pid); proc != nil {
		return proc.Name
	}
	return ""
}

func (p liveProcs) Cwd(pid int32) string {
	return proctree.Cwd(pid)
}

func within(path string, dir string) bool {
	if path == "" || dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// lockOwners names the owners of an answer's live locks, reading the process table once, at the first one.
func (u *Upcoming) lockOwners(places []AgentPlace, agents []BranchAgent) func(holder LockHolder, worktree string) LeftoverOwner {
	read := false
	var procs ProcFacts
	return func(holder LockHolder, worktree string) LeftoverOwner {
		if !read && u.env.Procs != nil {
			procs = u.env.Procs()
		}
		read = true
		return ResolveLockOwner(holder, worktree, places, agents, procs)
	}
}

// ResolveLockOwner names the live holder of worktree's lock. agents: the agents Upcoming placed on the branches
// (MatchBranchAgents, SubagentBranchAgents), whose sub-agents name their parent session.
func ResolveLockOwner(holder LockHolder, worktree string, places []AgentPlace, agents []BranchAgent, procs ProcFacts) LeftoverOwner {
	parentOf := map[string]bool{}
	for _, a := range agents {
		if a.Worktree == worktree && a.Kind != UpcomingAgentPanel && a.ParentBlockId != "" {
			parentOf[a.ParentBlockId] = true
		}
	}
	ofPlace := func(p AgentPlace, via string) LeftoverOwner {
		if parentOf[p.BlockId] {
			via = OwnerViaParent
		}
		return LeftoverOwner{Via: via, Pid: holder.Pid, BlockId: p.BlockId, FirstName: p.FirstName, Agent: p.Agent}
	}
	if procs != nil {
		for _, p := range places {
			if p.Review || p.Pid <= 0 {
				continue
			}
			if holder.Pid == p.Pid || procs.Under(holder.Pid, p.Pid) {
				return ofPlace(p, OwnerViaAgent)
			}
		}
	}
	for _, p := range places {
		if !p.Review && parentOf[p.BlockId] {
			return ofPlace(p, OwnerViaParent)
		}
	}
	for _, p := range places {
		if !p.Review && (p.Link == worktree || within(p.Cwd, worktree)) {
			return ofPlace(p, OwnerViaTerminal)
		}
	}
	owner := LeftoverOwner{Via: OwnerViaProcess, Pid: holder.Pid}
	if procs != nil {
		owner.Process = procs.Name(holder.Pid)
		owner.Folder = procs.Cwd(holder.Pid)
	}
	return owner
}
