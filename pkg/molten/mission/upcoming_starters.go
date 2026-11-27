// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// The session that started the work of each linked worktree (#2572): the first agent session MoltenTerm sees at work
// in it, its own panel there or one of its sub-agents (the lead's terminal for those). A worktree's work stays that
// session's when nobody is seen at work in it any more (a ticket waiting in AI Testing while its lead talks with the
// developer), so its companion keeps the ticket as its own instead of "in progress, nobody on it", and an anonymous
// background agent in it is named after that session. MoltenTerm's own record, in its data folder: no other tool is
// asked or needed.

const (
	StartersFileName = "worktree-starters.json"
	// The worktrees remembered, the oldest dropped first.
	maxWorktreeStarters = 256
)

type worktreeStarter struct {
	BlockId string `json:"blockid"`
	At      int64  `json:"at"`
}

// UpcomingStarter is a linked worktree of the project and the agent terminal that started its work, while that
// terminal still runs an agent.
type UpcomingStarter struct {
	Branch   string `json:"branch"`
	Worktree string `json:"worktree"`
	BlockId  string `json:"blockid"`
}

// StarterBook keeps the starters by worktree path; with no file, only for wavesrv's life.
type StarterBook struct {
	lock   sync.Mutex
	file   string
	loaded bool
	byTree map[string]worktreeStarter
}

func MakeStarterBook(file string) *StarterBook {
	return &StarterBook{file: file, byTree: map[string]worktreeStarter{}}
}

func (b *StarterBook) loadLocked() {
	if b.loaded {
		return
	}
	b.loaded = true
	if b.file == "" {
		return
	}
	data, err := os.ReadFile(b.file)
	if err != nil {
		return
	}
	var stored map[string]worktreeStarter
	if json.Unmarshal(data, &stored) != nil {
		return
	}
	for tree, s := range stored {
		if s.BlockId != "" && filepath.IsAbs(tree) {
			b.byTree[filepath.Clean(tree)] = s
		}
	}
}

func (b *StarterBook) saveLocked() {
	if b.file == "" {
		return
	}
	data, err := json.MarshalIndent(b.byTree, "", "  ")
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(b.file), 0700) != nil {
		return
	}
	tmp := b.file + ".tmp"
	if os.WriteFile(tmp, data, 0600) != nil {
		return
	}
	os.Rename(tmp, b.file)
}

// startedBy is the lead session of an agent at work in its worktree: a panel's own terminal, a sub-agent's or a
// background agent's lead, a signed background agent's signer; "" when none is known.
func startedBy(a BranchAgent) string {
	switch a.Kind {
	case UpcomingAgentPanel:
		if a.Visiting {
			return ""
		}
		return a.BlockId
	case UpcomingAgentSubagent:
		if a.State == "done" {
			return ""
		}
		return a.ParentBlockId
	case UpcomingAgentBackground:
		if a.ParentBlockId != "" {
			return a.ParentBlockId
		}
		return a.BlockId
	}
	return ""
}

// Note records the first lead seen at work in each linked worktree (trees[1:]), forgets the worktrees that are gone,
// and answers the starters of the project's worktrees whose terminal still runs an agent (live).
func (b *StarterBook) Note(trees []treeEntry, agents []BranchAgent, live map[string]bool, now int64) map[string]string {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.loadLocked()
	changed := false
	linked := map[string]treeEntry{}
	if len(trees) > 1 {
		for _, tree := range trees[1:] {
			linked[tree.path] = tree
		}
	}
	for _, a := range agents {
		lead := startedBy(a)
		if lead == "" || !live[lead] {
			continue
		}
		if _, ok := linked[a.Worktree]; !ok {
			continue
		}
		if _, known := b.byTree[a.Worktree]; known {
			continue
		}
		b.byTree[a.Worktree] = worktreeStarter{BlockId: lead, At: now}
		changed = true
	}
	for tree := range b.byTree {
		if _, ok := linked[tree]; ok {
			continue
		}
		if _, err := os.Stat(tree); os.IsNotExist(err) {
			delete(b.byTree, tree)
			changed = true
		}
	}
	if len(b.byTree) > maxWorktreeStarters {
		b.dropOldestLocked()
		changed = true
	}
	if changed {
		b.saveLocked()
	}
	rtn := map[string]string{}
	for path := range linked {
		if s, ok := b.byTree[path]; ok && live[s.BlockId] {
			rtn[path] = s.BlockId
		}
	}
	return rtn
}

func (b *StarterBook) dropOldestLocked() {
	trees := make([]string, 0, len(b.byTree))
	for tree := range b.byTree {
		trees = append(trees, tree)
	}
	sort.Slice(trees, func(i, j int) bool { return b.byTree[trees[i]].At < b.byTree[trees[j]].At })
	for _, tree := range trees[:len(trees)-maxWorktreeStarters] {
		delete(b.byTree, tree)
	}
}

// WithStarters names each anonymous background agent (no signature, no lead) after the session that started its
// worktree's work, and lists the project's starters by branch.
func WithStarters(trees []treeEntry, agents []BranchAgent, places []AgentPlace, starters map[string]string) ([]BranchAgent, []UpcomingStarter) {
	if len(starters) == 0 {
		return agents, nil
	}
	names := map[string]string{}
	for _, p := range places {
		names[p.BlockId] = p.FirstName
	}
	for i, a := range agents {
		if a.Kind != UpcomingAgentBackground || a.Signed || a.ParentBlockId != "" || a.BlockId != "" {
			continue
		}
		if lead, ok := starters[a.Worktree]; ok {
			agents[i].ParentBlockId, agents[i].ParentFirstName = lead, names[lead]
		}
	}
	var list []UpcomingStarter
	for _, tree := range trees {
		if lead, ok := starters[tree.path]; ok && tree.branch != "" {
			list = append(list, UpcomingStarter{Branch: tree.branch, Worktree: tree.path, BlockId: lead})
		}
	}
	return agents, list
}
