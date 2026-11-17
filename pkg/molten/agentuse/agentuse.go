// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package agentuse keeps how much each coding agent was used over the last days (FR-BOSS-009, AC93 to AC98, #2341):
// Brokk's usage grid orders its providers by it and hides the ones that were not used. It holds numbers only, as the hour
// they happened in: the time agents spent working, the sessions that started and the last moment of use. No prompt, no
// project, no folder and no credential is ever recorded.
package agentuse

import (
	"strconv"
	"sync"
	"time"
)

const (
	hourMs = int64(time.Hour / time.Millisecond)
	// WindowHours is the span a summary tells of: 7 days.
	WindowHours = 7 * 24
	// keepHours is what a record keeps, a day more than a summary reads, so the oldest hour is never cut short.
	keepHours = 8 * 24
	// SampleInterval is how often wavesrv looks at the agents.
	SampleInterval = 20 * time.Second
	// MaxGapMs is the longest time between two samples that counts as working time. A longer one is the computer
	// asleep, or wavesrv stopped: nothing is credited for it.
	MaxGapMs = int64(3 * SampleInterval / time.Millisecond)
)

// Run is one agent running in a terminal, as the agent states hold it.
type Run struct {
	BlockId string
	// Agent is the agent id ("claude", "codex"): the provider whose plan the run uses.
	Agent string
	// Started is when the run started (Unix milliseconds): with the block, it names the run.
	Started int64
	Working bool
}

// Use is what one agent was used over the last 7 days.
type Use struct {
	WorkMs   int64 `json:"workms"`
	Sessions int   `json:"sessions"`
	// LastAt is the last moment an agent of it worked or started (Unix milliseconds).
	LastAt int64 `json:"lastat"`
}

// Summary is what the windows read: the use of each agent over the last 7 days. An agent never used is not in it.
type Summary struct {
	At     int64          `json:"at"`
	Agents map[string]Use `json:"agents"`
}

type bucket struct {
	WorkMs   int64 `json:"workms,omitempty"`
	Sessions int   `json:"sessions,omitempty"`
	LastAt   int64 `json:"lastat,omitempty"`
}

// Recorder follows the runs it is shown and adds them to the hour they happened in. It holds no clock of its own: the
// caller says what time it is, so the rules are tested without waiting.
type Recorder struct {
	lock sync.Mutex
	// hours: by agent id, then by the hour's number since the epoch.
	hours map[string]map[int64]*bucket
	// lastSample: when the runs were last shown (Unix milliseconds), 0 before the first time.
	lastSample int64
	// seen: the runs already counted as a session.
	seen  map[string]bool
	dirty bool
}

func MakeRecorder() *Recorder {
	return &Recorder{hours: map[string]map[int64]*bucket{}, seen: map[string]bool{}}
}

func runKey(r Run) string {
	return r.BlockId + "|" + strconv.FormatInt(r.Started, 10)
}

func (r *Recorder) bucketLocked(agent string, hour int64) *bucket {
	byHour := r.hours[agent]
	if byHour == nil {
		byHour = map[int64]*bucket{}
		r.hours[agent] = byHour
	}
	b := byHour[hour]
	if b == nil {
		b = &bucket{}
		byHour[hour] = b
	}
	return b
}

// Sample is told, at `now`, which runs exist. The time since the previous sample is credited to each run that works
// (when it is no longer than MaxGapMs), and a run seen for the first time counts one session. It reports whether
// anything changed, so the caller writes the record only then.
func (r *Recorder) Sample(now time.Time, runs []Run) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	nowMs := now.UnixMilli()
	hour := nowMs / hourMs
	credit := int64(0)
	if gap := nowMs - r.lastSample; r.lastSample > 0 && gap > 0 && gap <= MaxGapMs {
		credit = gap
	}
	r.lastSample = nowMs
	current := make(map[string]bool, len(runs))
	for _, run := range runs {
		if run.Agent == "" {
			continue
		}
		key := runKey(run)
		current[key] = true
		if !r.seen[key] {
			b := r.bucketLocked(run.Agent, hour)
			b.Sessions++
			b.LastAt = nowMs
			r.dirty = true
		}
		if run.Working && credit > 0 {
			b := r.bucketLocked(run.Agent, hour)
			b.WorkMs += credit
			b.LastAt = nowMs
			r.dirty = true
		}
	}
	r.seen = current
	if r.trimLocked(hour) {
		r.dirty = true
	}
	return r.dirty
}

func (r *Recorder) trimLocked(hour int64) bool {
	trimmed := false
	for agent, byHour := range r.hours {
		for h := range byHour {
			if h <= hour-keepHours {
				delete(byHour, h)
				trimmed = true
			}
		}
		if len(byHour) == 0 {
			delete(r.hours, agent)
		}
	}
	return trimmed
}

// Summary adds up the last 7 days up to `now`.
func (r *Recorder) Summary(now time.Time) Summary {
	r.lock.Lock()
	defer r.lock.Unlock()
	nowMs := now.UnixMilli()
	hour := nowMs / hourMs
	out := Summary{At: nowMs, Agents: map[string]Use{}}
	for agent, byHour := range r.hours {
		var use Use
		for h, b := range byHour {
			if h <= hour-WindowHours || h > hour {
				continue
			}
			use.WorkMs += b.WorkMs
			use.Sessions += b.Sessions
			if b.LastAt > use.LastAt {
				use.LastAt = b.LastAt
			}
		}
		if use.WorkMs > 0 || use.Sessions > 0 {
			out.Agents[agent] = use
		}
	}
	return out
}

// Take gives the record to write and clears the changed mark, nil when nothing changed since the last time.
func (r *Recorder) Take() *File {
	r.lock.Lock()
	defer r.lock.Unlock()
	if !r.dirty {
		return nil
	}
	r.dirty = false
	return r.fileLocked()
}

// Restore puts back what a file held. It is for the start, before any sample.
func (r *Recorder) Restore(file File) {
	r.lock.Lock()
	defer r.lock.Unlock()
	for agent, byHour := range file.Agents {
		if agent == "" {
			continue
		}
		for key, b := range byHour {
			hour, err := strconv.ParseInt(key, 10, 64)
			if err != nil || hour < 0 {
				continue
			}
			held := r.bucketLocked(agent, hour)
			held.WorkMs += max(0, b.WorkMs)
			held.Sessions += max(0, b.Sessions)
			held.LastAt = max(held.LastAt, b.LastAt)
		}
	}
}
