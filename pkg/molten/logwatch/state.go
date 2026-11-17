// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
)

// What the watch keeps between looks (DS-BOSS-013): in MoltenTerm's data folder, private to the user, written whole
// each time (a temporary file, then a rename). It may hold the developer's paths and names, quoted from the log, so it
// never leaves this computer.

const (
	stateVersion  = 1
	stateDirName  = "logwatch"
	stateFileName = "state.json"

	// MaxSignatures: the signatures kept; the one seen longest ago goes first (FR-BOSS-012 AC5).
	MaxSignatures = 200
	// MaxMuted: the ignored signatures kept, apart, so that dropping a signature never brings back one the developer
	// ignored; the oldest goes first.
	MaxMuted = 500
	// historyMinutes: the counts per minute kept, for the spikes and the log's growth.
	historyMinutes = 60
)

type minuteCount struct {
	Minute int64 `json:"m"`
	Count  int64 `json:"n"`
}

// Signature is one kind of problem the log shows, and what the watch knows of it. Times are Unix milliseconds.
type Signature struct {
	Id      string   `json:"id"`
	Kind    string   `json:"kind"`
	Pattern string   `json:"pattern"`
	Frames  []string `json:"frames,omitempty"`
	// Excerpt: the last occurrence, its first line and the start of its stack, the home folder written ~.
	Excerpt string        `json:"excerpt"`
	First   int64         `json:"first"`
	Last    int64         `json:"last"`
	Count   int64         `json:"count"`
	Minutes []minuteCount `json:"minutes,omitempty"`
	// Raised: when its last card was raised; Event: why (EventNew or EventSpike); Asked: the first name of the agent the
	// developer asked to look since then.
	Raised int64  `json:"raised,omitempty"`
	Event  string `json:"event,omitempty"`
	Asked  string `json:"asked,omitempty"`
}

// growthMark is the card of a log that grows too fast: when it was raised, the figure it shows, who was asked.
type growthMark struct {
	Raised int64  `json:"raised,omitempty"`
	Bytes  int64  `json:"bytes,omitempty"`
	Asked  string `json:"asked,omitempty"`
}

// State is the file the watch keeps.
type State struct {
	Version int      `json:"version"`
	File    fileMark `json:"file"`
	// LookedAt: when the last look ran (Unix ms); the rotated logs written since then count in the growth.
	LookedAt int64 `json:"lookedat,omitempty"`
	// Bytes: the log's bytes per minute of their lines' stamps, over the last hour.
	Bytes      []minuteCount `json:"bytes,omitempty"`
	Growth     growthMark    `json:"growth"`
	Signatures []Signature   `json:"signatures"`
	// Muted: the ignored signatures and when they were ignored.
	Muted map[string]int64 `json:"muted,omitempty"`
}

func statePath(dataDir string) string {
	return filepath.Join(dataDir, "molten", stateDirName, stateFileName)
}

// loadState reads the kept state; a missing or unreadable file is a fresh start.
func loadState(path string) State {
	data, err := os.ReadFile(path)
	if err != nil {
		return State{Version: stateVersion}
	}
	var s State
	if json.Unmarshal(data, &s) != nil || s.Version != stateVersion {
		return State{Version: stateVersion}
	}
	return s
}

func saveState(path string, s State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(path, data, 0o600)
}

func minuteOf(ms int64) int64 {
	return ms / 60000
}

func addMinute(counts []minuteCount, minute int64, n int64) []minuteCount {
	for i := len(counts) - 1; i >= 0; i-- {
		if counts[i].Minute == minute {
			counts[i].Count += n
			return counts
		}
	}
	counts = append(counts, minuteCount{Minute: minute, Count: n})
	sort.Slice(counts, func(i, j int) bool { return counts[i].Minute < counts[j].Minute })
	return counts
}

// sumMinutes: the counts of the minutes from..to, both included, and how many of them have any.
func sumMinutes(counts []minuteCount, from int64, to int64) (int64, int) {
	var total int64
	busy := 0
	for _, c := range counts {
		if c.Minute < from || c.Minute > to || c.Count <= 0 {
			continue
		}
		total += c.Count
		busy++
	}
	return total, busy
}

func pruneMinutes(counts []minuteCount, newest int64) []minuteCount {
	var out []minuteCount
	for _, c := range counts {
		if c.Minute > newest-historyMinutes {
			out = append(out, c)
		}
	}
	return out
}

// prune keeps the state within its bounds.
func (s *State) prune(now time.Time) {
	nowMinute := minuteOf(now.UnixMilli())
	s.Bytes = pruneMinutes(s.Bytes, nowMinute)
	for i := range s.Signatures {
		s.Signatures[i].Minutes = pruneMinutes(s.Signatures[i].Minutes, minuteOf(s.Signatures[i].Last))
	}
	if len(s.Signatures) > MaxSignatures {
		// Past the cap, errors and warnings go first, the one seen longest ago first: a panic or a crash dropped would come
		// back as new, and one raised today would be raised twice the same day.
		nowMs := now.UnixMilli()
		tier := func(sig Signature) int {
			switch {
			case sig.Raised != 0 && nowMs-sig.Raised < RaiseEvery.Milliseconds():
				return 0
			case raisesNew(sig.Kind):
				return 1
			}
			return 2
		}
		sort.SliceStable(s.Signatures, func(i, j int) bool {
			a, b := tier(s.Signatures[i]), tier(s.Signatures[j])
			if a != b {
				return a < b
			}
			return s.Signatures[i].Last > s.Signatures[j].Last
		})
		s.Signatures = s.Signatures[:MaxSignatures]
	}
	sort.SliceStable(s.Signatures, func(i, j int) bool { return s.Signatures[i].Last > s.Signatures[j].Last })
	if len(s.Muted) > MaxMuted {
		ids := make([]string, 0, len(s.Muted))
		for id := range s.Muted {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool {
			if s.Muted[ids[i]] != s.Muted[ids[j]] {
				return s.Muted[ids[i]] < s.Muted[ids[j]]
			}
			return ids[i] < ids[j]
		})
		for _, id := range ids[:len(ids)-MaxMuted] {
			delete(s.Muted, id)
		}
	}
}

func (s *State) find(id string) int {
	for i := range s.Signatures {
		if s.Signatures[i].Id == id {
			return i
		}
	}
	return -1
}

func (s *State) muted(id string) bool {
	_, ok := s.Muted[id]
	return ok
}
