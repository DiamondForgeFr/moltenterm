// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
)

// Since when a lead is on a branch, and whether it works there at all (#1841, FR-REV-022 AC18). A lead's session may
// have started long before the branch existed, and a session that only ran a command in a ticket's worktree (git, gh,
// a workflow step) keeps its folder there afterwards: neither makes its whole session work on that branch. The panel's
// time on the branch starts when MoltenTerm saw it enter the worktree, and never before the worktree or the branch was
// created; a session placed in a worktree only by where its commands run (AgentPlace.Work), that wrote nothing there
// since it came, is only visiting it.

// panelSeen is where MoltenTerm last saw an agent terminal placed, and since when: the time of its move when it saw the
// terminal come from another worktree (moved), else the first time it saw it there.
type panelSeen struct {
	tree  string
	at    int64
	moved bool
}

// seenPanels records where each placed panel is now and returns since when, by terminal. Terminals no longer running
// are forgotten; a terminal placed in another project's worktree keeps its record.
func (u *Upcoming) seenPanels(places []AgentPlace, panels []BranchAgent, now int64) map[string]panelSeen {
	u.lock.Lock()
	defer u.lock.Unlock()
	running := map[string]bool{}
	for _, p := range places {
		running[p.BlockId] = true
	}
	for id := range u.seen {
		if !running[id] {
			delete(u.seen, id)
		}
	}
	rtn := map[string]panelSeen{}
	for _, a := range panels {
		if a.Kind != UpcomingAgentPanel || a.BlockId == "" {
			continue
		}
		s, ok := u.seen[a.BlockId]
		if !ok || s.tree != a.Worktree {
			s = panelSeen{tree: a.Worktree, at: now, moved: ok}
			u.seen[a.BlockId] = s
		}
		rtn[a.BlockId] = s
	}
	return rtn
}

// placedByWork: the session's commands place the terminal in that worktree, not the terminal's own folder or link.
func placedByWork(trees []treeEntry, p AgentPlace, worktree string) bool {
	if !filepath.IsAbs(p.Work) {
		return false
	}
	if path := placePath(p); path != "" {
		if own, ok := treeOf(trees, path); ok && own.path == worktree {
			return false
		}
	}
	return true
}

// branchCreatedAt: the oldest entry of the branch's reflog, in Unix milliseconds (0 when git keeps none).
func branchCreatedAt(g *gitReader, branch string) int64 {
	lines := g.lines("log", "-g", "--format=%ct", "refs/heads/"+branch, "--")
	for i := len(lines) - 1; i >= 0; i-- {
		if at, err := strconv.ParseInt(strings.TrimSpace(lines[i]), 10, 64); err == nil && at > 0 {
			return at * 1000
		}
	}
	return 0
}

// panelsOnBranch gives each placed panel its time on the branch (Started) and marks the visitors (Visiting).
func (u *Upcoming) panelsOnBranch(ctx context.Context, g *gitReader, trees []treeEntry, places []AgentPlace, panels []BranchAgent) []BranchAgent {
	if len(panels) == 0 || len(trees) == 0 {
		return panels
	}
	now := u.env.Now()
	seen := u.seenPanels(places, panels, now.UnixMilli())
	byBlock := map[string]AgentPlace{}
	for _, p := range places {
		byBlock[p.BlockId] = p
	}
	mainPath := trees[0].path
	rtn := make([]BranchAgent, 0, len(panels))
	for _, a := range panels {
		s, ok := seen[a.BlockId]
		if a.Kind != UpcomingAgentPanel || !ok {
			rtn = append(rtn, a)
			continue
		}
		floor := a.Started
		if at := branchCreatedAt(g, a.Branch); at > floor {
			floor = at
		}
		linked := a.Worktree != mainPath
		if linked {
			if at := u.env.FileTime(filepath.Join(a.Worktree, ".git")); at > floor {
				floor = at
			}
		}
		if s.moved && s.at > floor {
			floor = s.at
		}
		a.Started = floor
		if linked && placedByWork(trees, byBlock[a.BlockId], a.Worktree) {
			// Not seen coming: its writes of the last minutes before MoltenTerm first saw it there count.
			since := s.at
			if !s.moved {
				since = s.at - BackgroundActivityWindow.Milliseconds()
			}
			a.Visiting = u.treeActivity(ctx, a.Worktree) < since
		}
		rtn = append(rtn, a)
	}
	return rtn
}

// atWork: the agents without the visiting panels, those that hold a worktree for themselves (a visitor leaves its
// worktree to the sub-agent or background agent working there).
func atWork(agents []BranchAgent) []BranchAgent {
	rtn := make([]BranchAgent, 0, len(agents))
	for _, a := range agents {
		if !a.Visiting {
			rtn = append(rtn, a)
		}
	}
	return rtn
}
