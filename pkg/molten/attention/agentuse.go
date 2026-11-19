// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"log"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentuse"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// The use of each agent over 7 days (FR-BOSS-009, AC93 to AC98, #2341): the agent states look at the runs every
// agentuse.SampleInterval and the recorder adds what they did to the hour it happened in. The states themselves stay in
// memory only; the numbers are written, at most once every agentUseSaveEvery, to MoltenTerm's data folder.

const (
	agentUseDirName   = "agentuse"
	agentUseSaveEvery = time.Minute
)

type agentUseTracker struct {
	states   *agentStates
	recorder *agentuse.Recorder
	store    *agentuse.Store
	now      func() time.Time
	// lastSave is when the record was last written.
	lastSave time.Time
}

func makeAgentUseTracker(states *agentStates, store *agentuse.Store) *agentUseTracker {
	return &agentUseTracker{states: states, recorder: agentuse.MakeRecorder(), store: store, now: time.Now}
}

// useRuns are the runs that use an agent's own plan: a run that talks to another provider (Claude Code through a
// gateway) uses none of it. An agent whose sub-agents work is working even when its own session waits.
func useRuns(runs []molten.AgentRunInfo) []agentuse.Run {
	rtn := make([]agentuse.Run, 0, len(runs))
	for _, run := range runs {
		if !run.Running || run.Agent == "" || run.Settings.Provider != "" {
			continue
		}
		rtn = append(rtn, agentuse.Run{
			BlockId: run.BlockId,
			Agent:   run.Agent,
			Started: run.Started,
			Working: run.State == molten.AgentStateWorking || run.Subagents > 0,
		})
	}
	return rtn
}

// load puts back the record of the earlier runs of MoltenTerm.
func (t *agentUseTracker) load() {
	if t.store == nil {
		return
	}
	file, err := t.store.Load()
	if err != nil {
		log.Printf("molten: reading the agents' use: %v\n", err)
		return
	}
	t.recorder.Restore(file)
}

// tick looks at the runs now and writes the record when it changed and the last write is old enough.
func (t *agentUseTracker) tick() {
	now := t.now()
	t.recorder.Sample(now, useRuns(t.states.allRuns()))
	if t.store == nil || now.Sub(t.lastSave) < agentUseSaveEvery {
		return
	}
	file := t.recorder.Take()
	if file == nil {
		return
	}
	t.lastSave = now
	if err := t.store.Save(file); err != nil {
		log.Printf("molten: writing the agents' use: %v\n", err)
	}
}

func (t *agentUseTracker) run() {
	defer func() {
		panichandler.PanicHandler("molten:agentUse", recover())
	}()
	ticker := time.NewTicker(agentuse.SampleInterval)
	defer ticker.Stop()
	for range ticker.C {
		t.tick()
	}
}

func (t *agentUseTracker) summary() agentuse.Summary {
	return t.recorder.Summary(t.now())
}

var defaultAgentUse = makeAgentUseTracker(defaultAgentStates, nil)

// AgentUseSummary tells the use of each agent over the last 7 days.
func AgentUseSummary() agentuse.Summary {
	return defaultAgentUse.summary()
}

// RecordHeadlessUse adds a run MoltenTerm started without a terminal (the companion's ticket sentences, #2392) to the
// agent's use: its time is work time, written with the next sample.
func RecordHeadlessUse(agent string, ended time.Time, d time.Duration) {
	defaultAgentUse.recorder.AddWork(agent, ended, d.Milliseconds())
}

// startAgentUse keeps the record in the data folder: only wavesrv's own tracker does, tests' trackers do not.
func startAgentUse() {
	defaultAgentUse.store = agentuse.MakeStore(filepath.Join(wavebase.GetWaveDataDir(), "molten", agentUseDirName))
	defaultAgentUse.load()
	go defaultAgentUse.run()
}
