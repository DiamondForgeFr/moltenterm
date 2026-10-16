// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Codex keeps its rollout open while it runs (#799). Its notify links the session only at the end of a turn and its
// hooks are untrusted for one run (agentlaunch/codex.go), so a long first turn, or two Codex panes in one folder, left
// the companion guessing and the header without model or effort. The files the pane's agent process (or one of its
// processes: the npm wrapper starts the real binary) holds open name its session for sure, as soon as the rollout
// exists. Only metadata is read: the open files' paths, never another process's memory.
//
// The same loop follows each linked Codex run's settings: it reads only what was appended to the rollout since its
// previous look, for the turn_context and thread_settings_applied records, so the header shows the model and effort
// from the first turn on and follows /model, companion open or not.

const (
	// How often the Codex runs are looked at; nothing runs while there is none.
	processLinkInterval = 3 * time.Second
	// A wrapper's process tree is not walked further than this many processes.
	maxLinkProcs     = 32
	maxSubagentCache = 512
)

// ProcessLinker is an adapter whose agent keeps its own transcript open while it runs.
type ProcessLinker interface {
	// MainSession picks the session among the files the agent's processes hold open; false when none is one.
	MainSession(paths []string, isSubagent func(path string) bool) (string, bool)
}

// SettingsFollower reads an agent's settings from what was appended to its transcript since offset.
type SettingsFollower interface {
	ReadSettingsFrom(path string, offset int64) (molten.AgentSettings, bool, int64)
}

// MainSession: the rollouts under Codex's session folders that are not a sub-agent's; after /new the old rollout may
// stay open next to the new one, the most recently written is the live one.
func (a *CodexAdapter) MainSession(paths []string, isSubagent func(path string) bool) (string, bool) {
	type found struct {
		path string
		mod  time.Time
	}
	var rtn []found
	seen := map[string]bool{}
	for _, p := range paths {
		name := filepath.Base(p)
		if seen[p] || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		seen[p] = true
		resolved, err := ValidateSessionPath(a, p)
		if err != nil || isSubagent(resolved) {
			continue
		}
		info, err := os.Stat(resolved)
		if err != nil {
			continue
		}
		rtn = append(rtn, found{path: resolved, mod: info.ModTime()})
	}
	if len(rtn) == 0 {
		return "", false
	}
	sort.Slice(rtn, func(i, j int) bool {
		if !rtn[i].mod.Equal(rtn[j].mod) {
			return rtn[i].mod.After(rtn[j].mod)
		}
		return rtn[i].path < rtn[j].path
	})
	return rtn[0].path, true
}

// runTrack is what the loop keeps of one block's run.
type runTrack struct {
	agent   string
	started int64
	// holder: the process found holding the session last time, looked at first.
	holder int32
	// settingsPath: the session whose settings are followed, read up to offset.
	settingsPath string
	offset       int64
	settings     molten.AgentSettings
}

// isSubagentCached caches the adapter's answer: a rollout's first record never changes.
func (m *Manager) isSubagentCached(adapter Adapter, path string) bool {
	w, ok := adapter.(SessionFinder)
	if !ok {
		return false
	}
	m.lock.Lock()
	v, known := m.subagentPaths[path]
	m.lock.Unlock()
	if known {
		return v
	}
	v = w.IsSubagent(path)
	m.lock.Lock()
	defer m.lock.Unlock()
	if len(m.subagentPaths) >= maxSubagentCache {
		m.subagentPaths = map[string]bool{}
	}
	m.subagentPaths[path] = v
	return v
}

func (m *Manager) track(blockId string, run molten.AgentRunInfo) *runTrack {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.tracks[blockId]
	if t == nil || t.agent != run.Agent || t.started != run.Started {
		t = &runTrack{agent: run.Agent, started: run.Started}
		m.tracks[blockId] = t
	}
	return t
}

// processSession finds the session the run's processes hold open.
func (m *Manager) processSession(run molten.AgentRunInfo, adapter Adapter) (string, bool) {
	linker, ok := adapter.(ProcessLinker)
	if !ok || run.Pid <= 0 || m.openFiles == nil {
		return "", false
	}
	t := m.track(run.BlockId, run)
	isSub := func(path string) bool { return m.isSubagentCached(adapter, path) }
	tried := map[int32]bool{}
	try := func(pid int32) (string, bool) {
		if pid <= 0 || tried[pid] {
			return "", false
		}
		tried[pid] = true
		path, ok := linker.MainSession(m.openFiles(pid), isSub)
		if !ok {
			return "", false
		}
		m.lock.Lock()
		defer m.lock.Unlock()
		t.holder = pid
		return path, true
	}
	m.lock.Lock()
	holder := t.holder
	m.lock.Unlock()
	if path, ok := try(holder); ok {
		return path, true
	}
	if path, ok := try(run.Pid); ok {
		return path, true
	}
	if m.procTable == nil {
		return "", false
	}
	table, err := m.procTable()
	if err != nil || table == nil {
		return "", false
	}
	if run.PidStartMs != 0 && !table.Same(run.Pid, run.PidStartMs) {
		return "", false
	}
	for i, p := range table.Descendants(run.Pid) {
		if i >= maxLinkProcs {
			break
		}
		if path, ok := try(p.Pid); ok {
			return path, true
		}
	}
	return "", false
}

// linkProcess links a block to the session its agent's processes hold open, as a report of its own kind: like a
// hook's, it outranks discovery and guesses, and moves the pane on when the agent opens a new session.
func (m *Manager) linkProcess(run molten.AgentRunInfo, adapter Adapter) (string, bool) {
	path, ok := m.processSession(run, adapter)
	if !ok {
		return "", false
	}
	if r, ok := m.report(run.BlockId); ok && r.agent == run.Agent && r.path == path && !r.pending && m.reportIsCurrent(run.BlockId, r) {
		return path, true
	}
	if m.recordReport(run.BlockId, run.Agent, path, false, LinkProcess) != nil {
		return "", false
	}
	return path, true
}

func (m *Manager) reportIsCurrent(blockId string, r sessionReport) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.reportCurrentLocked(blockId, r)
}

// linkByProcess: an open companion without a report looks at its agent's open files, once per discovery interval.
func (w *watcher) linkByProcess(run molten.AgentRunInfo) bool {
	if _, ok := w.adapter.(ProcessLinker); !ok || run.Pid <= 0 || w.info.remote {
		return false
	}
	now := w.m.now()
	if now.Sub(w.processAt) < discoverInterval {
		return false
	}
	w.processAt = now
	path, ok := w.m.linkProcess(run, w.adapter)
	if !ok {
		return false
	}
	w.follow(path, LinkProcess, 0, "")
	w.setEarlier(false, "")
	return true
}

// followRuns is one look of the loop at the agents' runs: link the Codex runs to the sessions their processes hold,
// then read what their linked sessions appended for settings.
func (m *Manager) followRuns() {
	if m.allRuns == nil {
		return
	}
	live := map[string]bool{}
	for _, run := range m.allRuns() {
		if !run.Running {
			continue
		}
		adapter := m.adapterFor(run.Agent)
		if adapter == nil {
			continue
		}
		_, links := adapter.(ProcessLinker)
		follower, follows := adapter.(SettingsFollower)
		if !links && !follows {
			continue
		}
		if m.blockInfo != nil {
			if info, err := m.blockInfo(run.BlockId); err != nil || info.remote {
				continue
			}
		}
		live[run.BlockId] = true
		path, ok := m.linkProcess(run, adapter)
		if !ok {
			path = m.confidentPath(run.BlockId)
			if path == "" || !sameAgentPath(run.Agent, path) {
				continue
			}
		}
		if follows {
			m.followSettings(run, follower, path)
		}
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	for blockId := range m.tracks {
		if !live[blockId] {
			delete(m.tracks, blockId)
		}
	}
}

// followSettings reads what the session appended since the previous look and hands changed settings to the agent
// states; settings a new state record lost (the process seen again) are handed again.
func (m *Manager) followSettings(run molten.AgentRunInfo, follower SettingsFollower, path string) {
	if m.setSettings == nil {
		return
	}
	t := m.track(run.BlockId, run)
	m.lock.Lock()
	if t.settingsPath != path {
		t.settingsPath, t.offset, t.settings = path, 0, molten.AgentSettings{}
	}
	offset := t.offset
	m.lock.Unlock()
	settings, found, next := follower.ReadSettingsFrom(path, offset)
	m.lock.Lock()
	t.offset = next
	if found {
		t.settings = settings
	}
	current := t.settings
	m.lock.Unlock()
	if current == (molten.AgentSettings{}) {
		return
	}
	if m.runOf != nil {
		if now, ok := m.runOf(run.BlockId); ok && now.Settings == current {
			return
		}
	}
	m.setSettings(run.BlockId, run.Agent, current)
}

// startProcessLinks runs the loop for wavesrv's life.
func (m *Manager) startProcessLinks() {
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:companion:processlinks", recover())
		}()
		ticker := time.NewTicker(processLinkInterval)
		defer ticker.Stop()
		for range ticker.C {
			m.followRuns()
		}
	}()
}
