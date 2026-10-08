// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// When discovery cannot tell which session of a folder is a pane's (several panes run the same agent there, or
// several sessions were written since it started), the companion still opens on one, marked as guessed
// (DS-SHELL-060): a hook report or the user's pick replaces it. The guess only uses what wavesrv knows already: when
// each agent started, its state and since when, and when each transcript started and was last written.

// must match frontend/moltenterm-shell/companion/companion-model.ts
const (
	// GuessStarted: the session that started after this pane's agent, other panes' agents paired first.
	GuessStarted = "started"
	// GuessActivity: the session written while this pane's agent worked (or last written as it stopped).
	GuessActivity = "activity"
	// GuessRecent: the most recently updated session no other pane explains.
	GuessRecent = "recent"
)

// An agent writes its last record as its turn ends: a transcript last written this close to when the agent stopped
// working is that agent's.
const activitySlack = 10 * time.Second

// guessRun is one pane's agent, as the guess sees it.
type guessRun struct {
	blockId string
	started int64
	state   string
	since   int64
}

func makeGuessRun(run molten.AgentRunInfo) guessRun {
	return guessRun{blockId: run.BlockId, started: run.Started, state: run.State, since: run.StateSince}
}

// activityMatch tells whether a transcript's last write fits what the agent did: written since it started working,
// or last written about when it stopped. Without a known state nothing matches.
func activityMatch(r guessRun, c Candidate) bool {
	if r.state == "" || r.since == 0 || c.Modified == 0 {
		return false
	}
	if r.state == molten.AgentStateWorking {
		return c.Modified >= r.since-startSlack.Milliseconds()
	}
	d := c.Modified - r.since
	if d < 0 {
		d = -d
	}
	return d <= activitySlack.Milliseconds()
}

func absMillis(d int64) int64 {
	if d < 0 {
		return -d
	}
	return d
}

// startedAfter: the session began once the agent ran (a new session of that agent, or one it cleared to).
func startedAfter(r guessRun, c Candidate) bool {
	return c.Started != 0 && c.Started >= r.started-startSlack.Milliseconds()
}

// neverWorked tells a brand-new agent: idle since it started. A new agent writes its session only at its first
// prompt, so until then every session of the folder is someone else's. An unknown state is not taken for one.
func (r guessRun) neverWorked() bool {
	return r.state == molten.AgentStateIdle && r.since <= r.started+startSlack.Milliseconds()
}

// explainedByOther: another pane's agent activity explains the session's writes.
func explainedByOther(c Candidate, blockId string, runs []guessRun) bool {
	for _, r := range runs {
		if r.blockId != blockId && activityMatch(r, c) {
			return true
		}
	}
	return false
}

// better orders two sessions for one agent: the one its activity explains, then, for a working agent both fit, the
// one started closest to when it started working (two busy agents write two sessions at once: the newest written is
// a coin flip), then the most recently written.
func better(r guessRun, a Candidate, b Candidate) bool {
	am, bm := activityMatch(r, a), activityMatch(r, b)
	if am != bm {
		return am
	}
	if am && r.state == molten.AgentStateWorking {
		da, db := absMillis(a.Started-r.since), absMillis(b.Started-r.since)
		if da != db {
			return da < db
		}
	}
	if a.Modified != b.Modified {
		return a.Modified > b.Modified
	}
	return a.Path < b.Path
}

// guessCandidate chooses the session of self among free (the folder's sessions no other pane holds). others are the
// other panes running the same agent in the same folder without a link of their own; witnesses are those that only
// guessed theirs: they take no session here, but a session their activity explains is not self's.
//
// First, each agent that has worked, the most recently started first, is paired with the best of the sessions that
// started after it and that no other agent's activity explains instead (a new session cannot be older than the agent
// that wrote it; the latest agent has the fewest to choose from). Self takes its pair when it has one. Otherwise (a
// resumed session started before the agent), past the resume grace, among the sessions written since self started
// that no pairing took and no other agent's activity explains instead: the only one self's activity explains, else
// the most recently written. Nothing for an agent that has not worked yet.
func guessCandidate(free []Candidate, self guessRun, others []guessRun, witnesses []guessRun, now int64) (*Candidate, string) {
	if len(free) == 0 || self.neverWorked() {
		return nil, ""
	}
	runs := append([]guessRun{self}, others...)
	sort.SliceStable(runs, func(i, j int) bool {
		if runs[i].started != runs[j].started {
			return runs[i].started > runs[j].started
		}
		return runs[i].blockId < runs[j].blockId
	})
	explainers := append(append([]guessRun{}, runs...), witnesses...)
	paired := map[string]bool{}
	for _, r := range runs {
		if r.neverWorked() {
			continue
		}
		best := -1
		for i := range free {
			if paired[free[i].Path] || !startedAfter(r, free[i]) {
				continue
			}
			if !activityMatch(r, free[i]) && explainedByOther(free[i], r.blockId, explainers) {
				continue
			}
			if best < 0 || better(r, free[i], free[best]) {
				best = i
			}
		}
		if best < 0 {
			continue
		}
		paired[free[best].Path] = true
		if r.blockId != self.blockId {
			continue
		}
		chosen := free[best]
		if activityMatch(self, chosen) {
			return &chosen, GuessActivity
		}
		return &chosen, GuessStarted
	}
	// A resumed session started before the agent: only once the agent is past its grace.
	if now-self.started < resumeGrace.Milliseconds() {
		return nil, ""
	}
	var rest []Candidate
	for _, c := range free {
		if paired[c.Path] || c.Modified < self.started-startSlack.Milliseconds() {
			continue
		}
		if !activityMatch(self, c) && explainedByOther(c, self.blockId, explainers) {
			continue
		}
		rest = append(rest, c)
	}
	if len(rest) == 0 {
		return nil, ""
	}
	var matching []Candidate
	for _, c := range rest {
		if activityMatch(self, c) {
			matching = append(matching, c)
		}
	}
	if len(matching) == 1 {
		return &matching[0], GuessActivity
	}
	pool := rest
	if len(matching) > 1 {
		pool = matching
	}
	best := 0
	for i := range pool {
		if better(self, pool[i], pool[best]) {
			best = i
		}
	}
	chosen := pool[best]
	return &chosen, GuessRecent
}
