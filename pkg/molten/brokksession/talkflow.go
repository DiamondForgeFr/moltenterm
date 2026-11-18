// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The way of a message (FR-BOSS-009, AC15, AC23, #2028, #2033, #2257, #2284): it goes to his session, waits for him
// while his prompt is taken, and his answer is read from his transcript until his agent is done with it. A message sent
// while he is still answering never loses the first answer: when his agent cannot take it, the first answer keeps
// coming in; when it takes it, the first answer is read to its end, by its turn, before the second is followed.

// Say gives the message to his session, starting it when it does not exist, then follows his answer. Returns what came
// of the message. The calls use a context of their own: a window that closes meanwhile never cuts a message short.
func (t *Talk) Say(req TalkSayRequest) TalkState {
	typed := strings.TrimSpace(req.Text)
	origin := cleanOrigin(req.Origin)
	var (
		gen          int
		lead         string
		conversation string
		state        TalkState
		joined       bool
	)
	t.update(func() bool {
		conversation = t.shown
		// A message already waits for him (#2284): this one joins the one of its own conversation, and both go together
		// once he is free; in the other conversation it waits after it (#2285).
		if len(t.waiting) > 0 {
			joined = true
			for _, w := range t.waiting {
				if w.Conversation == conversation {
					w.Text = joinQueued(w.Text, typed)
					state = t.state
					return true
				}
			}
			t.waiting = append(t.waiting, &TalkWaiting{Text: typed, Since: t.nowMs(), Conversation: conversation, lead: t.lead, origin: origin})
			state = t.state
			return true
		}
		lead = t.lead
		t.sendGen++
		gen = t.sendGen
		t.stateOwner = ""
		t.state = TalkState{Phase: PhaseSending}
		return true
	})
	if joined {
		return state
	}
	text := withLead(lead, typed)
	var existing Result
	if t.env.Lookup != nil {
		existing = t.env.Lookup(context.Background())
	}
	stale := false
	t.update(func() bool {
		t.keepBlockLocked(existing.BlockId)
		if gen != t.sendGen {
			stale, state = true, t.state
			return false
		}
		if existing.Status != StatusNone {
			return false
		}
		t.state = TalkState{Phase: PhaseStarting}
		return true
	})
	if stale {
		return state
	}
	sentAt := t.nowMs() - sentSlack.Milliseconds()
	state = t.give(req, text)
	var (
		takeGen int
		take    bool
		drain   bool
	)
	t.update(func() bool {
		if gen != t.sendGen {
			// Another message started while this try was on its way, and his agent took this one: it went, so it shows.
			take, takeGen = state.Phase == PhaseAnswering, t.sendGen
			return false
		}
		switch state.Phase {
		case PhaseBusy:
			// His agent was busy: the message waits in his talk window, and goes by itself once he is free (#2257,
			// #2284). The lead stays for the try that is taken.
			t.waiting = append(t.waiting, &TalkWaiting{Text: typed, Since: t.nowMs(), Conversation: conversation, lead: lead, origin: origin})
			state = queuedOf(state)
			t.state = state
			drain = true
		case PhaseAnswering:
			if t.lead == lead {
				t.lead = ""
			}
			take, takeGen = true, gen
		default:
			// The first answer, if one is still coming, keeps coming: nothing was taken.
			t.state = state
		}
		return true
	})
	if drain {
		go t.drain(gen, req.ClearPrompt)
	}
	if take {
		t.takeOver(text, sentAt, state, takeGen, conversation, origin)
	}
	return state
}

// give is one try at giving the message to his session.
func (t *Talk) give(req TalkSayRequest, text string) TalkState {
	if t.env.Say == nil {
		return talkStateOf(nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), sayTimeout)
	defer cancel()
	result := t.env.Say(ctx, Request{WorkspaceId: req.WorkspaceId, Name: req.Name, Text: text, ClearPrompt: req.ClearPrompt})
	t.read(func() { t.keepBlockLocked(result.BlockId) })
	return talkStateOf(&result)
}

// drain tries the waiting messages again, oldest first, until his agent takes each. While his own prompt is taken it
// only waits, with no limit; the time he seems free and still refuses one is bounded (queueBound), and a failure gives
// the texts back to their fields with a note that says what happened. A message keeps its conversation (#2285).
func (t *Talk) drain(gen int, clearPrompt bool) {
	defer func() {
		panichandler.PanicHandler("molten:brokksession:drain", recover())
	}()
	var refused int64
	for {
		live := true
		t.read(func() { live = gen == t.sendGen && len(t.waiting) > 0 })
		if !live {
			return
		}
		t.env.Wait(QueueEvery)
		t.read(func() { live = gen == t.sendGen && len(t.waiting) > 0 })
		if !live {
			return
		}
		if t.facts().PromptBusy {
			continue
		}
		var (
			head   *TalkWaiting
			sent   string
			lead   string
			sentAt int64
		)
		t.read(func() {
			head = t.waiting[0]
			sent = head.Text
			lead = head.lead
			if head.Conversation == t.shown {
				lead = t.lead
			}
			sentAt = t.nowMs() - sentSlack.Milliseconds()
		})
		text := withLead(lead, sent)
		state := t.give(TalkSayRequest{ClearPrompt: clearPrompt}, text)
		stale, take := false, false
		t.update(func() bool {
			if gen != t.sendGen {
				stale = true
				return false
			}
			if state.Phase == PhaseAnswering {
				// What the developer added while this try was on its way waits for the next turn.
				if later := laterThan(head.Text, sent); later != "" {
					head.Text, head.Since = later, t.nowMs()
				} else {
					t.removeWaitingLocked(head)
				}
				if head.Conversation == t.shown && t.lead == lead {
					t.lead = ""
				}
				refused = 0
				take = true
				return true
			}
			if state.Phase == PhaseBusy {
				refused += QueueEvery.Milliseconds()
				if refused < queueBound(state).Milliseconds() {
					t.state = queuedOf(state)
					return true
				}
			}
			// A real failure: the texts go back to their fields, and the note says what happened.
			for _, w := range t.waiting {
				t.giveBackLocked(w)
			}
			t.waiting = nil
			t.state = state
			stale = true
			return true
		})
		if stale {
			return
		}
		if take {
			t.takeOver(text, sentAt, state, gen, head.Conversation, head.origin)
		}
	}
}

func (t *Talk) removeWaitingLocked(w *TalkWaiting) {
	for i, other := range t.waiting {
		if other == w {
			t.waiting = append(t.waiting[:i:i], t.waiting[i+1:]...)
			return
		}
	}
}

// takeOver: his agent has the message. The answer before it is read to its end, the message joins the exchange, and
// its answer is followed.
func (t *Talk) takeOver(text string, sentAt int64, state TalkState, gen int, conversation string, origin string) {
	var prior *tracked
	t.read(func() {
		if t.tracked != nil && !t.tracked.stopped {
			prior = t.tracked
			prior.stopped = true
		}
	})
	if prior != nil {
		t.readToItsEnd(prior)
	}
	var tr *tracked
	t.update(func() bool {
		if gen != t.sendGen {
			return false
		}
		tr = &tracked{id: t.nextId("m"), conversation: conversation, origin: origin, text: text, sentAt: sentAt}
		t.appendLocked(conversation, TalkEntry{Id: tr.id, Role: RoleYou, Text: text, At: t.nowMs(), Taken: true, Origin: origin})
		t.tracked = tr
		t.stateOwner = tr.id
		t.state = state
		t.keepBlockLocked(blockOfWhere(state.Where))
		return true
	})
	if tr != nil {
		go t.follow(tr, state)
	}
}

func blockOfWhere(where *TalkWhere) string {
	if where == nil {
		return ""
	}
	return where.BlockId
}

func (t *Talk) readReply(after int64, index int) *Reply {
	if t.env.Reply == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), findTimeout)
	defer cancel()
	reply, ok := t.env.Reply(ctx, ReplyRequest{After: after, Index: index})
	if !ok {
		return nil
	}
	return &reply
}

// readToItsEnd reads the answer of an earlier message once more, by its turn: a newer turn does not change it.
func (t *Talk) readToItsEnd(tr *tracked) {
	var after int64
	var turn int
	t.read(func() { after, turn = tr.sentAt, tr.turn })
	reply := t.readReply(after, turn)
	t.update(func() bool {
		if reply != nil && reply.Status == ReplyAnswer {
			return t.keepAnswerLocked(tr, *reply, true)
		}
		return t.finishLocked(tr)
	})
}

// follow reads his answer until his agent is done with the message, or gives up and says where it is.
func (t *Talk) follow(tr *tracked, state TalkState) {
	defer func() {
		panichandler.PanicHandler("molten:brokksession:follow", recover())
	}()
	var f followState
	until := t.env.Now().Add(MaxFollow)
	for {
		t.env.Wait(FollowEvery)
		var (
			stopped bool
			after   int64
			turn    int
		)
		t.read(func() { stopped, after, turn = tr.stopped, tr.sentAt, tr.turn })
		if stopped {
			return
		}
		reply := t.readReply(after, turn)
		if reply != nil {
			t.read(func() { t.keepBlockLocked(reply.BlockId) })
		}
		facts := t.facts()
		pending := false
		if t.env.Pending != nil {
			pending = t.env.Pending() != nil
		}
		done := false
		t.update(func() bool {
			changed := t.keepApprovalsLocked(reply)
			if tr.stopped {
				return changed
			}
			var next TalkState
			// A request or a question his window shows is a wait for the developer too, answered there (AC100, AC101).
			next, f, done = followStep(state, f, reply, facts.Working, facts.Waiting || pending)
			if !done && t.env.Now().After(until) {
				next.Phase = PhaseNoReply
				done = true
			}
			state = next
			if reply != nil && reply.Status == ReplyAnswer {
				if t.keepAnswerLocked(tr, *reply, done) {
					changed = true
				}
			} else if done && t.finishLocked(tr) {
				changed = true
			}
			if t.stateOwner == tr.id && !sameState(t.state, state) {
				t.state = state
				changed = true
			}
			if done {
				tr.stopped = true
				changed = true
			}
			return changed
		})
		if done {
			return
		}
	}
}

func sameState(a TalkState, b TalkState) bool {
	if a.Phase != b.Phase || a.Reason != b.Reason || a.AgentName != b.AgentName || a.Started != b.Started || a.Reply != b.Reply {
		return false
	}
	if (a.Where == nil) != (b.Where == nil) {
		return false
	}
	return a.Where == nil || *a.Where == *b.Where
}
