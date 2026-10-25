// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Upcoming answers the Reviews view's upcoming work (#712), through the same collector as the review list.
func (r *Reviews) Upcoming(req UpcomingRequest) (UpcomingAnswer, error) {
	return r.upcomingOf().Get(req)
}

func (r *Reviews) upcomingOf() *Upcoming {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.upcoming == nil {
		r.upcoming = MakeUpcoming(liveUpcomingEnv(r.collector, r.run))
	}
	return r.upcoming
}

// liveUpcomingEnv:the collector's snapshot as it is (the upcoming work never starts a GitHub read of its own beyond
// the tickets' query) and the running agents of the agent states, placed by their terminal's folder.
func liveUpcomingEnv(collector *Collector, run Runner) UpcomingEnv {
	return UpcomingEnv{
		Run: run,
		Snapshot: func(dir string) (Snapshot, bool) {
			if snap, ok := collector.Cached(dir); ok {
				return snap, true
			}
			return Snapshot{}, false
		},
		Agents:    liveAgentPlaces,
		Subagents: liveSubagents,
		ReviewTreesDir: func(projectDir string) string {
			return molten.ReviewTreesDir(wavebase.GetWaveDataDir(), projectDir)
		},
	}
}

// liveSubagents reads the sub-agents of each running agent panel from their own files, through the companion
// (#1035): the same identity the Now card shows.
func liveSubagents(places []AgentPlace) []PaneSubagent {
	return PaneSubagentsOf(places, companion.PaneSubagents)
}

// PaneSubagentsOf gives each running Claude Code or Codex panel the sub-agents read finds for it.
func PaneSubagentsOf(places []AgentPlace, read func(blockId string) []companion.SubagentIdentity) []PaneSubagent {
	var rtn []PaneSubagent
	for _, p := range places {
		if p.Review || (p.Agent != molten.AgentIdClaude && p.Agent != molten.AgentIdCodex) {
			continue
		}
		for _, id := range read(p.BlockId) {
			if id.Worktree == "" || !filepath.IsAbs(id.Worktree) {
				continue
			}
			id.Worktree = realPath(id.Worktree)
			rtn = append(rtn, PaneSubagent{ParentBlockId: p.BlockId, ParentFirstName: p.FirstName, Agent: p.Agent, SubagentIdentity: id})
		}
	}
	return rtn
}

// liveAgentPlaces lists the running agents of local terminals with their folders, symlinks resolved like git's paths.
func liveAgentPlaces(ctx context.Context) []AgentPlace {
	var rtn []AgentPlace
	for _, run := range attention.AgentRuns() {
		if !run.Running || run.BlockId == "" {
			continue
		}
		block, err := wstore.DBGet[*waveobj.Block](ctx, run.BlockId)
		if err != nil || block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
			continue
		}
		place := AgentPlace{BlockId: run.BlockId, Agent: run.Agent, FirstName: run.FirstName, Started: run.Started}
		if link := block.Meta.GetString(molten.WorktreeMetaKey, ""); link != "" {
			place.Link = realPath(link)
		}
		conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
		cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
		if (conn == "" || conn == "local") && filepath.IsAbs(cwd) {
			place.Cwd = realPath(cwd)
		}
		_, place.Review = block.Meta[mcpreview.SessionMetaKey]
		rtn = append(rtn, place)
	}
	return rtn
}
