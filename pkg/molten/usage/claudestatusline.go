// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"os"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Claude Code's documented source (FR-SHELL-027, DS-SHELL-031): the rate limits of its status line input, which
// `molten agent statusline` hands to wavesrv for the pane it runs in. They stay in memory, per block, and are kept
// only while the user shows Claude Code's plan usage (NFR-SHELL-011).

const (
	ClaudeStatusLineSourceId = "claude-statusline"
	WindowSpend              = "spend"

	maxStatusLineBlocks = 64
	fiveHourMins        = 5 * 60
	sevenDayMins        = 7 * 24 * 60
)

type statusLineRecord struct {
	req molten.AgentStatusLineRequest
	at  int64
}

// StatusLineStore keeps the last status line windows of each block.
type StatusLineStore struct {
	lock    sync.Mutex
	records map[string]statusLineRecord
}

func MakeStatusLineStore() *StatusLineStore {
	return &StatusLineStore{records: map[string]statusLineRecord{}}
}

// DefaultStatusLineStore is the store `molten agent statusline` reports go to.
var DefaultStatusLineStore = MakeStatusLineStore()

// Record keeps a block's windows; changed tells whether they differ from the ones it had.
func (st *StatusLineStore) Record(req molten.AgentStatusLineRequest, nowMs int64) bool {
	st.lock.Lock()
	defer st.lock.Unlock()
	prev, had := st.records[req.BlockId]
	if !had && len(st.records) >= maxStatusLineBlocks {
		st.evictOldestLocked()
	}
	st.records[req.BlockId] = statusLineRecord{req: req, at: nowMs}
	return !had || !sameStatusLine(prev.req, req)
}

func (st *StatusLineStore) evictOldestLocked() {
	oldest, at := "", int64(0)
	for id, r := range st.records {
		if oldest == "" || r.at < at {
			oldest, at = id, r.at
		}
	}
	delete(st.records, oldest)
}

func (st *StatusLineStore) get(blockId string) (statusLineRecord, bool) {
	st.lock.Lock()
	defer st.lock.Unlock()
	r, ok := st.records[blockId]
	return r, ok
}

// Has tells whether a block's relay reported since the gauges were turned on.
func (st *StatusLineStore) Has(blockId string) bool {
	_, ok := st.get(blockId)
	return ok
}

func (st *StatusLineStore) Forget(blockId string) {
	st.lock.Lock()
	defer st.lock.Unlock()
	delete(st.records, blockId)
}

func (st *StatusLineStore) Clear() {
	st.lock.Lock()
	defer st.lock.Unlock()
	st.records = map[string]statusLineRecord{}
}

func sameWindow(a *molten.StatusLineWindow, b *molten.StatusLineWindow) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func sameStatusLine(a molten.AgentStatusLineRequest, b molten.AgentStatusLineRequest) bool {
	return a.RateLimits == b.RateLimits && sameWindow(a.FiveHour, b.FiveHour) && sameWindow(a.SevenDay, b.SevenDay) &&
		sameWindow(a.SpendLimit, b.SpendLimit)
}

type claudeStatusLineSource struct {
	store *StatusLineStore
	setup func(cwd string) molten.StatusLineSetup
}

// MakeClaudeStatusLineSource reads the store; setup reads Claude Code's settings for the snippet.
func MakeClaudeStatusLineSource(store *StatusLineStore, setup func(cwd string) molten.StatusLineSetup) GaugesSource {
	return &claudeStatusLineSource{store: store, setup: setup}
}

func (s *claudeStatusLineSource) Id() string       { return ClaudeStatusLineSourceId }
func (s *claudeStatusLineSource) Name() string     { return "Claude Code status line" }
func (s *claudeStatusLineSource) Documented() bool { return true }

func (s *claudeStatusLineSource) Enabled(settings *wconfig.SettingsType) bool {
	return GaugesOn(settings, "claude")
}

func (s *claudeStatusLineSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	r, ok := s.store.get(blockId)
	if !ok {
		return UsageSnapshot{}, Unavailable(ReasonWaiting)
	}
	if !r.req.RateLimits {
		return UsageSnapshot{}, Unavailable(ReasonNoPlan)
	}
	if !r.req.HasWindows() {
		return UsageSnapshot{}, Unavailable(ReasonFormat)
	}
	snap := UsageSnapshot{Agent: "claude", Source: ClaudeStatusLineSourceId, ReadAt: r.at}
	add := func(w *molten.StatusLineWindow, id string, label string, mins int64) {
		if w == nil {
			return
		}
		snap.Windows = append(snap.Windows, UsageWindow{
			Id:          id,
			Label:       label,
			UsedPercent: w.UsedPercent,
			ResetsAt:    w.ResetsAt * 1000,
			WindowMins:  mins,
		})
	}
	add(r.req.FiveHour, WindowSession, "Current session", fiveHourMins)
	add(r.req.SevenDay, WindowWeek, "This week", sevenDayMins)
	add(r.req.SpendLimit, WindowSpend, "Spend limit", 0)
	return snap, nil
}

func (s *claudeStatusLineSource) Clear() {
	s.store.Clear()
}

func (s *claudeStatusLineSource) Setup(cwd string) *UsageSetup {
	if s.setup == nil {
		return nil
	}
	setup := s.setup(cwd)
	if setup.Configured {
		return nil
	}
	return &UsageSetup{
		Source:   ClaudeStatusLineSourceId,
		File:     setup.File,
		Current:  setup.Current,
		Language: setup.Language,
		Snippet:  setup.Snippet,
	}
}

// claudeStatusLineSetup reads the user's own Claude Code settings, as the hook offer does.
func claudeStatusLineSetup(cwd string) molten.StatusLineSetup {
	home, err := os.UserHomeDir()
	if err != nil {
		return molten.StatusLineSetup{Configured: true}
	}
	return molten.ClaudeStatusLineSetup(molten.AgentEnv{Home: home, Getenv: os.Getenv}, cwd)
}
