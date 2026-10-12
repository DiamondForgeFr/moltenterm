// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"errors"
	"log"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// Background work (#493, DS-SHELL-025 revision of 2026-10-12). An agent whose turn ended may still run background
// subagents and background commands in processes of its own: its state says done (or idle, waiting, error) while the
// work runs. Such an agent counts as work while its process tree is busy: in the last BusyWindow its descendants used
// at least BusyTreeCpu of CPU, or its own process BusyAgentCpu. The CPU is read as cumulative times, whose growth
// between two samples is what was used meanwhile; a percentage at one instant would miss bursts and count spikes.
// The thresholds sit well above what an agent at its prompt uses with its MCP servers (measured on 2026-10-12: Claude
// Code 0.46 to 0.95 s a minute for its own process and at most 0.06 s for its descendants, the Codex app-server tree
// 0.03 s), so an idle agent is not work. A background command that waits without CPU (a sleep, a CI watch) is not
// seen.
//
// Cost (FR-PERF-011): no poller of its own. The keeper's evaluation asks, only while it follows the terminals, and
// only for running agents that are not working and whose local process is known; a sample reads the process table
// once and the CPU of each process of those trees, at most every busySampleEvery.

const (
	BusyWindow   = 60 * time.Second
	BusyTreeCpu  = 500 * time.Millisecond
	BusyAgentCpu = 2 * time.Second

	busySampleEvery = 5 * time.Second
	// A tree that has only its first sample is read again at the next evaluation (the keeper evaluates every 2 s):
	// its first verdict is not a whole interval late.
	busyFirstResample = 1500 * time.Millisecond
	// A tree not sampled for this long (the keeper stopped following the terminals) starts from a new first sample:
	// what it used meanwhile is not recent.
	busyMaxGap = 15 * time.Second
	// Start times are compared within a second, as proctree.Table.Same does: platforms round them differently.
	startToleranceMs = 1000
)

// TreeRoot is an agent's process: its pid and its start time (Unix milliseconds), which tells a reused pid apart.
type TreeRoot struct {
	BlockId string
	Pid     int32
	StartMs int64
}

// ProcSample is one process of a tree at a sample.
type ProcSample struct {
	Ppid    int32
	StartMs int64
	Cpu     proctree.Cpu
	// Agent: the agent's own process, measured against BusyAgentCpu: the root, or a process under it named after an
	// agent (the native binary an npm wrapper starts, as Codex's does), whose idle TUI is not background work.
	Agent bool
}

// TreeSample is a tree at a sample: the root and its live descendants, by pid.
type TreeSample map[int32]ProcSample

// TreeSampler reads the given roots' trees, by block id, with one read of the process table for all of them; a root
// that is gone or unreadable is left out.
type TreeSampler func(roots []TreeRoot) map[string]TreeSample

type cpuSpent struct {
	at    time.Time
	agent time.Duration
	tree  time.Duration
}

type treeHistory struct {
	root   TreeRoot
	last   TreeSample
	lastAt time.Time
	// spent: the CPU used between consecutive samples, within the window.
	spent []cpuSpent
}

type busyTracker struct {
	lock      sync.Mutex
	sample    TreeSampler
	now       func() time.Time
	trees     map[string]*treeHistory
	sampledAt time.Time
}

func makeBusyTracker(sample TreeSampler, now func() time.Time) *busyTracker {
	return &busyTracker{sample: sample, now: now, trees: map[string]*treeHistory{}}
}

func sameStart(a int64, b int64) bool {
	if a <= 0 || b <= 0 {
		return true
	}
	diff := a - b
	return diff > -startToleranceMs && diff < startToleranceMs
}

// Busy tells which of the roots' trees are busy now. A tree no longer asked for is forgotten: an agent working again,
// gone or in a new process starts over from a first sample, which tells nothing yet.
func (b *busyTracker) Busy(roots []TreeRoot) map[string]bool {
	b.lock.Lock()
	defer b.lock.Unlock()
	now := b.now()
	wanted := make(map[string]TreeRoot, len(roots))
	for _, r := range roots {
		if r.BlockId != "" && r.Pid > 0 {
			wanted[r.BlockId] = r
		}
	}
	for id, h := range b.trees {
		r, ok := wanted[id]
		if !ok || r.Pid != h.root.Pid || !sameStart(r.StartMs, h.root.StartMs) {
			delete(b.trees, id)
		}
	}
	if len(wanted) == 0 || b.sample == nil {
		return nil
	}
	if b.dueLocked(now, wanted) {
		b.sampleLocked(now, wanted)
	}
	var rtn map[string]bool
	for id := range wanted {
		h := b.trees[id]
		if h == nil || !h.busy(now) {
			continue
		}
		if rtn == nil {
			rtn = map[string]bool{}
		}
		rtn[id] = true
	}
	return rtn
}

func (b *busyTracker) dueLocked(now time.Time, wanted map[string]TreeRoot) bool {
	since := now.Sub(b.sampledAt)
	if b.sampledAt.IsZero() || since >= busySampleEvery {
		return true
	}
	if since < busyFirstResample {
		return false
	}
	for id := range wanted {
		if h := b.trees[id]; h == nil || len(h.spent) == 0 {
			return true
		}
	}
	return false
}

func (b *busyTracker) sampleLocked(now time.Time, wanted map[string]TreeRoot) {
	list := make([]TreeRoot, 0, len(wanted))
	for _, r := range wanted {
		list = append(list, r)
	}
	samples := b.sample(list)
	b.sampledAt = now
	for id, root := range wanted {
		cur := samples[id]
		if _, ok := cur[root.Pid]; !ok {
			delete(b.trees, id)
			continue
		}
		h := b.trees[id]
		if h == nil || now.Sub(h.lastAt) > busyMaxGap {
			b.trees[id] = &treeHistory{root: root, last: cur, lastAt: now}
			continue
		}
		agent, tree := cpuSpentBetween(root.Pid, h.last, cur, h.lastAt)
		h.spent = append(h.spent, cpuSpent{at: now, agent: agent, tree: tree})
		h.last, h.lastAt = cur, now
		kept := h.spent[:0]
		for _, s := range h.spent {
			if now.Sub(s.at) < BusyWindow {
				kept = append(kept, s)
			}
		}
		h.spent = kept
	}
}

func (h *treeHistory) busy(now time.Time) bool {
	var agent, tree time.Duration
	for _, s := range h.spent {
		if now.Sub(s.at) < BusyWindow {
			agent += s.agent
			tree += s.tree
		}
	}
	return agent >= BusyAgentCpu || tree >= BusyTreeCpu
}

func growth(before time.Duration, after time.Duration) time.Duration {
	if after > before {
		return after - before
	}
	return 0
}

// cpuSpentBetween is the CPU a tree used between two samples: agent, the own CPU of the agent's processes (ProcSample.
// Agent); tree, everything else (their reaped children, and each other descendant's own and reaped). A process started
// since the previous sample counts
// whole. A process that ended moved its CPU into its parent's reaped total: what was already counted of it is taken
// off there, so it is not counted twice.
func cpuSpentBetween(rootPid int32, prev TreeSample, cur TreeSample, prevAt time.Time) (time.Duration, time.Duration) {
	ended := map[int32]time.Duration{}
	for pid, p := range prev {
		if c, ok := cur[pid]; ok && sameStart(c.StartMs, p.StartMs) {
			continue
		}
		ended[p.Ppid] += p.Cpu.Total()
	}
	var agent, tree time.Duration
	for pid, c := range cur {
		var self, children time.Duration
		p, known := prev[pid]
		switch {
		case known && sameStart(c.StartMs, p.StartMs):
			self, children = growth(p.Cpu.Self, c.Cpu.Self), growth(p.Cpu.Children, c.Cpu.Children)
		case c.StartMs <= 0 || c.StartMs >= prevAt.UnixMilli()-startToleranceMs:
			self, children = c.Cpu.Self, c.Cpu.Children
		default:
			// Older than the previous sample and not in it (its CPU could not be read then): what it used so far is not
			// this interval's.
			continue
		}
		children = growth(ended[pid], children)
		if pid == rootPid || c.Agent {
			agent += self
			tree += children
			continue
		}
		tree += self + children
	}
	return agent, tree
}

// isAgentName tells a process named after a known agent's command (`codex`, `claude`).
func isAgentName(name string) bool {
	base := filepath.Base(name)
	for _, kind := range molten.AgentKinds {
		if slices.Contains(kind.Commands, base) {
			return true
		}
	}
	return false
}

// sampleTrees is the TreeSampler of wavesrv: one read of the process table, then the CPU of each process of the
// roots' trees (proctree.MaxWalk bounds a tree).
func sampleTrees(roots []TreeRoot) map[string]TreeSample {
	table, err := proctree.Read()
	if err != nil {
		if !errors.Is(err, proctree.ErrUnsupported) {
			log.Printf("molten: keep-awake: process table not read: %v\n", err)
		}
		return nil
	}
	rtn := map[string]TreeSample{}
	for _, root := range roots {
		if !table.Same(root.Pid, root.StartMs) {
			continue
		}
		procs := append([]*proctree.Proc{table.Get(root.Pid)}, table.Descendants(root.Pid)...)
		sample := make(TreeSample, len(procs))
		for _, p := range procs {
			cpu, ok := proctree.ReadCpu(p.Pid)
			if !ok {
				continue
			}
			sample[p.Pid] = ProcSample{Ppid: p.Ppid, StartMs: p.StartMs, Cpu: cpu, Agent: p.Pid == root.Pid || isAgentName(p.Name)}
		}
		if _, ok := sample[root.Pid]; ok {
			rtn[root.BlockId] = sample
		}
	}
	return rtn
}
