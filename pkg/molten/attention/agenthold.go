// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// States MoltenTerm holds (#896): for a run whose end MoltenTerm judges (an agent fixing a PR's CI), the agent's hooks
// do not say when the work is over: its Stop hook reports done when its turn ends, while the PR may still be red. While
// a block is held, the windows see the hold's state and words whenever the agent itself neither works, waits for an
// answer nor failed; the agent's done and idle never show, and its "is done" notification is not raised. The holder
// releases the block with the state it ends on (done once the PR's checks pass). A hold lives in memory with the block.

type agentHold struct {
	state   string
	message string
	text    *uimsg.Text
}

// ownStateLocked: the agent's own state shows through a hold: it works, asks or failed.
func ownStateLocked(rec *agentRecord) bool {
	switch rec.state {
	case molten.AgentStateWorking, molten.AgentStateWaiting, molten.AgentStateError:
		return true
	}
	return false
}

// heldInfoLocked applies the block's hold, if any, to what the windows see.
func (a *agentStates) heldInfoLocked(blockId string, rec *agentRecord, info *molten.AgentStateInfo) {
	hold := a.holds[blockId]
	if hold == nil {
		return
	}
	if rec.state == molten.AgentStateWorking && hold.state == molten.AgentStateWorking {
		// The agent at work keeps the hold's words: the windows say what it works on ("fixing the CI of #N").
		info.Message, info.MessageText = hold.message, hold.text
		return
	}
	if ownStateLocked(rec) {
		return
	}
	info.State, info.Message, info.MessageText = hold.state, hold.message, hold.text
}

func (a *agentStates) heldLocked(blockId string) bool {
	return a.holds[blockId] != nil
}

func (a *agentStates) hold(blockId string, state string, message string, text *uimsg.Text) {
	a.lock.Lock()
	defer a.lock.Unlock()
	prev := a.holds[blockId]
	if prev != nil && prev.state == state && prev.message == message {
		return
	}
	a.holds[blockId] = &agentHold{state: state, message: message, text: text}
	a.markDirtyLocked(blockId)
}

// release ends the hold; the agent's record takes state with the hold's last words (a done that turns green, which
// the developer's look clears as any other), unless the agent itself works, asks or failed.
func (a *agentStates) release(blockId string, state string, message string, text *uimsg.Text) {
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.holds[blockId] == nil {
		return
	}
	delete(a.holds, blockId)
	a.markDirtyLocked(blockId)
	rec := a.records[blockId]
	if rec == nil || !rec.running || state == "" || ownStateLocked(rec) {
		return
	}
	a.setStateLocked(blockId, rec, state, message)
	rec.messageText = text
}

// heldDoneSignal: a held block's own "done" signal (a bell or OSC saying the turn is over) raises no notification.
func (a *agentStates) heldDoneSignal(blockId string, signal AttentionSignal) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.heldLocked(blockId) && molten.AttentionAgentState(signal.Title, signal.Message) == molten.AgentStateDone
}

// HoldAgentState makes MoltenTerm the owner of a terminal's agent state (#896).
func HoldAgentState(blockId string, state string, message string, text *uimsg.Text) {
	if blockId == "" || !molten.ValidAgentState(state) {
		return
	}
	defaultAgentStates.hold(blockId, state, message, text)
}

// ReleaseAgentState gives the terminal's agent state back to its agent, ending on state ("" leaves the agent's own).
func ReleaseAgentState(blockId string, state string, message string, text *uimsg.Text) {
	defaultAgentStates.release(blockId, state, message, text)
}
