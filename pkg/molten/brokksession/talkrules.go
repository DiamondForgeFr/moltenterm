// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"strings"
	"time"
)

// The rules of Brokk's talk (FR-BOSS-009, AC23, #2028, #2033, #2257, #2284): what came of a message, how his answer is
// followed, how long a message waits for him. They were the window's (brokk-talk-model.ts) until #2382 moved the talk
// to wavesrv, where every window reads the same one (AC99).

const (
	// Phase…: the state of the last message; must match TalkPhase in frontend/moltenterm-shell/boss/brokk-talk-model.ts.
	// idle: nothing to say; starting: the first message starts his session; sending: on its way; queued: his agent was
	// busy, and the message goes by itself once he is free; answering: his agent has it; needsanswer: his agent stopped
	// on a prompt and waits for the developer; answered: his answer is here; unread: he answered where it cannot be
	// read; noreply: no answer came. The others are the failures of the message.
	PhaseIdle         = "idle"
	PhaseStarting     = "starting"
	PhaseSending      = "sending"
	PhaseQueued       = "queued"
	PhaseAnswering    = "answering"
	PhaseNeedsAnswer  = "needsanswer"
	PhaseAnswered     = "answered"
	PhaseUnread       = "unread"
	PhaseNoReply      = "noreply"
	PhaseBusy         = "busy"
	PhaseNoAgent      = "noagent"
	PhaseAgentMissing = "agentmissing"
	PhaseFailed       = "failed"

	// ReasonUnreachable: the call to his session did not answer (the window's own reason before #2382).
	ReasonUnreachable = "unreachable"

	// How his answer is followed: an agent that never shows it working, or a reply that cannot be read, is given up on
	// after these many readings in a row without work.
	FollowEvery              = 1500 * time.Millisecond
	IdleReadingsForNoReply   = 20
	IdleReadingsForUnread    = 3
	IdleReadingsForAnswered  = 2
	FailedReadingsForNoReply = 5
	MaxFollow                = 20 * time.Minute

	// A message his agent was too busy to take waits for him (#2257, #2284): it is tried again this often. While his
	// own prompt is taken it waits with no limit; only the time he seems free and still refuses it counts, up to
	// MaxQueue (MaxUnsettledQueue for an agent whose state cannot be read), then the failure is said.
	QueueEvery        = 2 * time.Second
	MaxQueue          = 10 * time.Minute
	MaxUnsettledQueue = 2 * time.Minute

	// The answer's time is his agent's clock, the message's wavesrv's: the same computer, give or take a record.
	sentSlack = 2 * time.Second
)

// TalkWhere is where his terminal is: the way out when his answer, or the prompt he waits on, is only there.
type TalkWhere struct {
	WorkspaceId string `json:"workspaceid"`
	TabId       string `json:"tabid"`
	BlockId     string `json:"blockid"`
}

// TalkState is the state of the last message, as every window shows it.
type TalkState struct {
	Phase     string     `json:"phase"`
	Reason    string     `json:"reason,omitempty"`
	AgentName string     `json:"agentname,omitempty"`
	Started   bool       `json:"started,omitempty"`
	Reply     string     `json:"reply,omitempty"`
	Where     *TalkWhere `json:"where,omitempty"`
}

var IdleTalk = TalkState{Phase: PhaseIdle}

func whereOf(blockId string, tabId string, workspaceId string) *TalkWhere {
	if blockId == "" || tabId == "" {
		return nil
	}
	return &TalkWhere{WorkspaceId: workspaceId, TabId: tabId, BlockId: blockId}
}

func whereOfReply(reply *Reply) *TalkWhere {
	if reply == nil {
		return nil
	}
	return whereOf(reply.BlockId, reply.TabId, reply.WorkspaceId)
}

// talkStateOf is what the answer to a message says; a message his agent has goes on to wait for his answer. nil: the
// call did not answer.
func talkStateOf(result *Result) TalkState {
	if result == nil {
		return TalkState{Phase: PhaseFailed, Reason: ReasonUnreachable}
	}
	phase := PhaseFailed
	switch result.Status {
	case StatusSent:
		phase = PhaseAnswering
	case StatusBusy:
		phase = PhaseBusy
	case StatusNoAgent:
		phase = PhaseNoAgent
	case StatusMissing:
		phase = PhaseAgentMissing
	}
	return TalkState{
		Phase:     phase,
		Reason:    result.Reason,
		AgentName: result.AgentName,
		Started:   result.Started,
		Where:     whereOf(result.BlockId, result.TabId, result.WorkspaceId),
	}
}

// followState counts the readings of an answer: idle, in a row while his agent did not work; failed, in a row that
// could not be read; worked: it was seen working since the message.
type followState struct {
	idle   int
	failed int
	worked bool
}

// followStep is one reading of his answer: the next state, and whether the following is done. working: his agent works
// now; waiting: it waits for the developer (#2155), on a prompt of his terminal or on a request his window shows. A
// wait is no silence: it is said, and the following goes on, so that his answer is read once it goes on.
func followStep(state TalkState, f followState, reply *Reply, working bool, waiting bool) (TalkState, followState, bool) {
	if waiting && (reply == nil || reply.Status != StatusNone) {
		if where := whereOfReply(reply); where != nil {
			state.Where = where
		}
		if reply != nil && reply.Status == ReplyAnswer {
			state.Reply = reply.Markdown
		}
		state.Phase = PhaseNeedsAnswer
		f.idle, f.failed = 0, 0
		return state, f, false
	}
	if state.Phase == PhaseNeedsAnswer {
		state.Phase = PhaseAnswering
	}
	if reply == nil {
		f.failed++
		if f.failed >= FailedReadingsForNoReply {
			state.Phase = PhaseNoReply
			return state, f, true
		}
		return state, f, false
	}
	if where := whereOfReply(reply); where != nil {
		state.Where = where
	}
	if reply.Status == StatusNone {
		state.Phase, state.Reason, state.Where = PhaseFailed, ReasonGone, nil
		return state, f, true
	}
	next := followState{idle: f.idle + 1, worked: f.worked || working}
	if working {
		next.idle = 0
	}
	if reply.Status == ReplyAnswer {
		state.Phase, state.Reply = PhaseAnswering, reply.Markdown
		if next.idle >= IdleReadingsForAnswered {
			state.Phase = PhaseAnswered
			return state, next, true
		}
		return state, next, false
	}
	// A reply that cannot be read is in his terminal once his agent worked on the message and stopped.
	if reply.Status == ReplyUnread && ((next.worked && next.idle >= IdleReadingsForUnread) || next.idle >= IdleReadingsForNoReply) {
		state.Phase = PhaseUnread
		return state, next, true
	}
	if next.idle >= IdleReadingsForNoReply {
		state.Phase = PhaseNoReply
		return state, next, true
	}
	return state, next, false
}

// queuedOf is what a busy answer becomes while the message waits for him.
func queuedOf(state TalkState) TalkState {
	if state.Phase == PhaseBusy {
		state.Phase = PhaseQueued
	}
	return state
}

// queueBound is how long a message waits for him while he seems free, by what kept him busy.
func queueBound(state TalkState) time.Duration {
	if state.Reason == ReasonUnsettled {
		return MaxUnsettledQueue
	}
	return MaxQueue
}

func onItsWay(state TalkState) bool {
	return state.Phase == PhaseSending || state.Phase == PhaseStarting
}

// withLead puts the words of the brainstorm before the developer's message (#2246).
func withLead(lead string, text string) string {
	if lead == "" {
		return text
	}
	return lead + " " + text
}

// joinQueued: a message sent while one waits joins it, one per paragraph (#2284).
func joinQueued(queued string, text string) string {
	return queued + "\n\n" + text
}

// laterThan is what the developer added to a waiting message while a try of it was on its way.
func laterThan(now string, sent string) string {
	if now == sent || !strings.HasPrefix(now, sent) {
		return ""
	}
	return strings.TrimSpace(now[len(sent):])
}

// withApprovals adds the approvals of the latest reading to those shown, each once, in their order.
func withApprovals(shown []AutoApproval, read []AutoApproval) []AutoApproval {
	if len(read) == 0 {
		return shown
	}
	known := map[string]bool{}
	for _, a := range shown {
		known[a.Id] = true
	}
	rtn := shown
	for _, a := range read {
		if a.Id == "" || known[a.Id] {
			continue
		}
		known[a.Id] = true
		rtn = append(rtn, a)
	}
	return rtn
}
