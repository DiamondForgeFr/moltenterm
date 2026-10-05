// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Output activity (#217): an agent whose hooks never reported in its pane shows working while its pane keeps
// producing output (its spinner, its streamed text), and idle again once the output stays quiet. Only when output
// comes is used, never what it says.
//
// A run is a sequence of output chunks no further apart than activityGap. It means working once it lasted
// activitySustain and counted activityMinChunks chunks: a one-off redraw (the agent showing its prompt again) is
// one short burst and never gets there. The echo of what the user types and the redraw of a resize, output within
// activityEchoWindow of the input or resize in that pane, are not counted. An agent idling at its prompt sends
// nothing, so it settles on idle activityQuiet after the last counted chunk (#201's endless pulse came from a
// working state nothing ended).

const (
	activityEchoWindow = 400 * time.Millisecond
	activityGap        = 1500 * time.Millisecond
	activitySustain    = 2 * time.Second
	activityMinChunks  = 5
	activityQuiet      = 4 * time.Second
	// How often a working state from output activity is checked for quiet.
	activitySettleEvery = time.Second
)

// paneActivity is what the output activity needs to know of a pane. It outlives the agent's record, so that an
// agent whose hooks reported once keeps them authoritative when it runs again in the same pane.
type paneActivity struct {
	// hookedAgent: the agent a hook reported for in this pane; its output activity is ignored.
	hookedAgent string
	typed       time.Time
	runStart    time.Time
	lastOut     time.Time
	chunks      int
}

func (a *agentStates) paneLocked(blockId string) *paneActivity {
	p := a.panes[blockId]
	if p == nil {
		p = &paneActivity{}
		a.panes[blockId] = p
	}
	return p
}

// typedLocked notes that the user sent input to the pane, or resized it: the output that follows right after is its
// echo or its redraw, and a run of output only counts from there.
func (a *agentStates) typedLocked(blockId string, now time.Time) {
	if a.records[blockId] == nil {
		return
	}
	p := a.paneLocked(blockId)
	p.typed = now
	p.chunks = 0
}

func (a *agentStates) resized(blockId string) {
	now := a.now()
	a.lock.Lock()
	defer a.lock.Unlock()
	a.typedLocked(blockId, now)
}

func (a *agentStates) hookedLocked(blockId string, agent string) {
	p := a.paneLocked(blockId)
	p.hookedAgent = agent
	p.chunks = 0
}

// output sees that a chunk of output came for a terminal, after its signals and marks applied.
func (a *agentStates) output(blockId string) {
	now := a.now()
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil || !rec.running {
		return
	}
	p := a.paneLocked(blockId)
	if p.hookedAgent == rec.agent {
		return
	}
	if now.Sub(p.typed) < activityEchoWindow {
		return
	}
	if p.chunks == 0 || now.Sub(p.lastOut) > activityGap {
		p.runStart = now
		p.chunks = 0
	}
	p.lastOut = now
	p.chunks++
	// Waiting and done stay until the user answers (Enter, agentStates.input): an agent that asked for a
	// permission may still redraw its question.
	if rec.state != molten.AgentStateIdle {
		return
	}
	if p.chunks < activityMinChunks || now.Sub(p.runStart) < activitySustain {
		return
	}
	a.setStateLocked(blockId, rec, molten.AgentStateWorking, "")
	rec.fromActivity = true
}

// settleActivity sends back to idle the agents whose working state came from output that has stayed quiet.
func (a *agentStates) settleActivity() {
	now := a.now()
	a.lock.Lock()
	defer a.lock.Unlock()
	for blockId, rec := range a.records {
		if !rec.fromActivity || rec.state != molten.AgentStateWorking {
			continue
		}
		p := a.panes[blockId]
		if p != nil && now.Sub(p.lastOut) < activityQuiet {
			continue
		}
		a.setStateLocked(blockId, rec, molten.AgentStateIdle, "")
	}
}

func (a *agentStates) runSettle() {
	defer func() {
		panichandler.PanicHandler("molten:agentActivity", recover())
	}()
	ticker := time.NewTicker(activitySettleEvery)
	defer ticker.Stop()
	for range ticker.C {
		a.settleActivity()
	}
}
