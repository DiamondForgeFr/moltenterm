// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/subagentwork"
)

// What a lead agent's sub-agents work on, kept for every reader (#2502, FR-SHELL-018, FR-SHELL-084). The sub-agents'
// own files say it (PaneSubagents); it is written to pkg/molten/subagentwork, the one owner the agent states read too:
// the agent states forget a lead's sub-agents when its turn ends, the files do not, and a sub-agent that waits on its
// own tests or build sends no hook for hours.
//
// Reading the files is not free, so a block is read again when something says it may have changed (its agent's state,
// a sub-agent's hook) at most every leadSweepMin, and every leadSweepEvery for as long as a sub-agent of it works:
// the end of a job, which is written to the sub-agent's transcript and nowhere else, shows within that. Nothing is
// scheduled for a block whose agent has no sub-agent at work. Claude Code only: it is the agent whose sub-agents' files
// and background commands are read cheaply; Codex and Kimi Code are recorded when PaneSubagents is asked for them.

const (
	// A change that may have moved a lead's sub-agents is read after this short moment, so a burst is one read.
	leadSweepDelay = 800 * time.Millisecond
	// Two reads of a block are at least this far apart, however often its agent reports.
	leadSweepMin = 5 * time.Second
	// While a sub-agent of a block works, its work is read again this often.
	leadSweepEvery = 15 * time.Second
)

// registry is where the manager keeps the work: wavesrv's own unless a test gave it another.
func (m *Manager) registry() *subagentwork.Registry {
	if m == nil || m.work == nil {
		return subagentwork.Default
	}
	return m.work
}

// leadWorkOf is the sub-agents of a listing that work now: running, which includes those waiting on their own jobs.
func leadWorkOf(ids []SubagentIdentity) []molten.SubagentWork {
	var rtn []molten.SubagentWork
	for _, id := range ids {
		if id.State != SubagentRunning || id.AgentId == "" {
			continue
		}
		started := id.FirstWrite
		if started == 0 {
			started = id.Started
		}
		rtn = append(rtn, molten.SubagentWork{
			Id: id.AgentId, Description: id.Description, Kind: id.Kind, Started: started, Waiting: id.Waiting, Jobs: id.Jobs,
		})
	}
	return rtn
}

type leadSweeper struct {
	lock   sync.Mutex
	timers map[string]*leadTimer
	last   map[string]time.Time
}

type leadTimer struct {
	timer *time.Timer
	due   time.Time
}

func makeLeadSweeper() *leadSweeper {
	return &leadSweeper{timers: map[string]*leadTimer{}, last: map[string]time.Time{}}
}

// SweepLead reads a lead's sub-agents soon: its agent's state or a hook of its sub-agents changed.
func (m *Manager) SweepLead(blockId string) {
	m.sweepSoon(blockId, leadSweepDelay)
}

// leadStateChanged follows a block's agent state: a Claude Code lead's sub-agents are read soon, and what is known of a
// run that ended goes.
func (m *Manager) leadStateChanged(info molten.AgentStateInfo) {
	if info.Cleared {
		m.ForgetLead(info.BlockId)
		return
	}
	if info.Agent == molten.AgentIdClaude {
		m.SweepLead(info.BlockId)
	}
}

// ForgetLead drops what is known of a lead (its agent run ended, its terminal closed).
func (m *Manager) ForgetLead(blockId string) {
	if m.sweeper != nil {
		m.sweeper.stop(blockId)
	}
	m.registry().Forget(blockId)
}

func (s *leadSweeper) stop(blockId string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if t := s.timers[blockId]; t != nil {
		t.timer.Stop()
	}
	delete(s.timers, blockId)
	delete(s.last, blockId)
}

// leadDue is when a read asked `after` from now is made: never sooner than leadSweepMin after the last read of the
// block (a zero last is none).
func leadDue(now time.Time, after time.Duration, last time.Time) time.Time {
	due := now.Add(after)
	if !last.IsZero() && due.Before(last.Add(leadSweepMin)) {
		return last.Add(leadSweepMin)
	}
	return due
}

// sweepSoon schedules a read of the block, unless one is already due as soon.
func (m *Manager) sweepSoon(blockId string, after time.Duration) {
	if m == nil || blockId == "" || m.runOf == nil || m.sweeper == nil || m.afterFunc == nil {
		return
	}
	s := m.sweeper
	s.lock.Lock()
	defer s.lock.Unlock()
	now := m.now()
	due := leadDue(now, after, s.last[blockId])
	if t := s.timers[blockId]; t != nil {
		if !t.due.After(due) {
			return
		}
		t.timer.Stop()
	}
	entry := &leadTimer{due: due}
	entry.timer = m.afterFunc(due.Sub(now), func() { m.sweepLeadAt(blockId, entry) })
	s.timers[blockId] = entry
}

// sweepLeadAt is the timer's end: the read, then the next one while a sub-agent still works.
func (m *Manager) sweepLeadAt(blockId string, entry *leadTimer) {
	if !m.takeSweep(blockId, entry) {
		return
	}
	if m.SweepLeadNow(blockId) {
		m.sweepSoon(blockId, leadSweepEvery)
	}
}

// takeSweep ends the timer that fired and notes the read, unless another timer took its place.
func (m *Manager) takeSweep(blockId string, entry *leadTimer) bool {
	s := m.sweeper
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.timers[blockId] != entry {
		return false
	}
	delete(s.timers, blockId)
	s.last[blockId] = m.now()
	return true
}

// SweepLeadNow reads a lead's sub-agents now and records them; it tells whether one of them works, which is when the
// next read is due. A block whose agent is not running any more has none. Only Claude Code's are read here: another
// agent's are recorded when PaneSubagents is asked for them.
func (m *Manager) SweepLeadNow(blockId string) bool {
	run, ok := m.runOf(blockId)
	if !ok || !run.Running {
		m.registry().Forget(blockId)
		return false
	}
	if run.Agent != molten.AgentIdClaude {
		return false
	}
	m.PaneSubagents(blockId, HookSubagents(blockId))
	return m.registry().Count(blockId) > 0
}

// recordLeadWork keeps a listing of a block's sub-agents where the agent states read it.
func (m *Manager) recordLeadWork(blockId string, ids []SubagentIdentity) {
	m.registry().Set(blockId, leadWorkOf(ids))
}

// withLeadWork gives the sub-agents the session lists the facts the files add: their agent id, whether they wait on
// background work of their own, and the jobs they wait for.
func (m *Manager) withLeadWork(blockId string, subs []SubagentInfo) []SubagentInfo {
	work := m.registry().Get(blockId)
	byAgent := make(map[string]molten.SubagentWork, len(work))
	for _, w := range work {
		byAgent[w.Id] = w
	}
	for i := range subs {
		w, ok := byAgent[subs[i].AgentId]
		if !ok {
			continue
		}
		subs[i].Waiting = subs[i].Waiting || w.Waiting
		subs[i].Jobs = w.Jobs
	}
	return subs
}
