// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"strings"

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
	// settled (#1876): a waiting hold that someone decided; see settleStop.
	settled *agentSettle
}

// agentSettle: who settled the stop, why and when. rec and seq are the agent's record and its state change then, which
// tie the settlement to that stop: the agent working again (or stopping again) moves them, and the settlement no
// longer applies.
type agentSettle struct {
	by   string
	note string
	at   int64
	rec  *agentRecord
	seq  int64
}

func (s *agentSettle) appliesTo(rec *agentRecord) bool {
	return s != nil && rec != nil && s.rec == rec && s.seq == rec.stateSeq
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
	if hold.state == molten.AgentStateWaiting && hold.settled != nil {
		if hold.settled.appliesTo(rec) {
			info.State, info.Message, info.MessageText = molten.AgentStateIdle, "", nil
			info.Settled = &molten.AgentSettled{By: hold.settled.by, Note: hold.settled.note, At: hold.settled.at}
			return
		}
		hold.settled = nil
	}
	info.State, info.Message, info.MessageText = hold.state, hold.message, hold.text
}

// settleStop records that someone decided the stop MoltenTerm holds on the block (#1876). A settled stop shows idle,
// with who settled it and why, until the agent works or stops again. A stop the agent itself raises (a prompt of its
// terminal) is not MoltenTerm's to settle: answering it is what moves the agent.
func (a *agentStates) settleStop(blockId string, by string, note string) string {
	a.lock.Lock()
	defer a.lock.Unlock()
	hold := a.holds[blockId]
	rec := a.records[blockId]
	if hold == nil || rec == nil || !rec.running || hold.state != molten.AgentStateWaiting {
		return molten.AgentSettleNone
	}
	if ownStateLocked(rec) {
		if rec.state == molten.AgentStateWaiting {
			return molten.AgentSettleOwnPrompt
		}
		return molten.AgentSettleNone
	}
	hold.settled = &agentSettle{by: by, note: note, at: a.now().UnixMilli(), rec: rec, seq: rec.stateSeq}
	a.markDirtyLocked(blockId)
	return molten.AgentSettleDone
}

// stopSettled: the block's stop is settled and the settlement still applies.
func (a *agentStates) stopSettled(blockId string) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	hold := a.holds[blockId]
	rec := a.records[blockId]
	return hold != nil && hold.settled.appliesTo(rec) && !ownStateLocked(rec)
}

// cleanSettleText: one line, cut to molten.AgentSettleNoteMax runes.
func cleanSettleText(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	if runes := []rune(text); len(runes) > max {
		return strings.TrimSpace(string(runes[:max-1])) + "…"
	}
	return text
}

// SettleAgentStop settles the stop held on a terminal (#1876): by is the settler's first name, "" for the developer.
// The result is one of molten.AgentSettleDone, AgentSettleNone and AgentSettleOwnPrompt.
func SettleAgentStop(blockId string, by string, note string) string {
	if blockId == "" {
		return molten.AgentSettleNone
	}
	return defaultAgentStates.settleStop(blockId, cleanSettleText(by, 64), cleanSettleText(note, molten.AgentSettleNoteMax))
}

// AgentStopSettled: the terminal's stop is settled and the settlement applies (the PR follow stops raising it).
func AgentStopSettled(blockId string) bool {
	return defaultAgentStates.stopSettled(blockId)
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
