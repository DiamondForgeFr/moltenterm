// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package termupdate

import (
	"context"
	"fmt"
	"sync"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// A message to MoltenTerm's own agent session (Brokk's, FR-BOSS-009, #2257). That session lives in a hidden tab: no human
// types there unless they opened it. The hand-off path types without Enter whenever its watch cannot rule out a draft,
// which left each message of Brokk's field unsent, and every retry stacked it again: after a restart, an agent whose
// hooks have not reported since looks as if it always held one. This path never leaves anything in the prompt:
//   - text a human typed there (seen by the input watch, or remembered by the session's owner across restarts) is never
//     sent nor cleared: nothing is typed;
//   - text MoltenTerm itself left there since the watch saw the prompt emptied is cleared first, so a retry never
//     stacks the message;
//   - a prompt the watch has not seen emptied (after a restart) is never cleared on a guess: nothing is typed, and the
//     developer may choose to empty it (ClearConfirmed);
//   - Enter is pressed only when the agent is at rest at its prompt, asked again right before each key: its hooks
//     report its states, or its transcript shows its last turn ended with no call pending (a permission question is
//     a pending call), so the message never answers a question nor cuts a turn;
//   - otherwise nothing is typed, and the caller tries again later.

const (
	// MaxOwnSessionText is the longest text typed into the own session, in characters: the developer's message, and the
	// brief it may carry when the session started before the brief changed.
	MaxOwnSessionText = 16000

	// InputReasonUnsettled: the agent's state is not known well enough to press Enter (no hook since the start, and no
	// transcript showing it at rest). Nothing was typed.
	InputReasonUnsettled = "unsettled"
	// InputReasonHumanDraft: a human's unsent text is in the prompt. Nothing was typed.
	InputReasonHumanDraft = "humandraft"
	// InputReasonUnknownPrompt: the watch has not seen the prompt emptied since it started (a restart), so it may hold
	// text nobody knows of. Nothing was typed; the developer may choose to empty it (ClearConfirmed).
	InputReasonUnknownPrompt = "unknownprompt"

	// Ctrl+C empties the whole input of Claude Code and Codex, a multi-line paste included, and does nothing else while
	// they wait at their prompt with text in it.
	keyClearInput = "\x03"
)

// OwnPromptFacts is what the session's owner knows that the watch cannot.
type OwnPromptFacts struct {
	// HumanTyped: a human's text was left in the prompt before this wavesrv started (the owner remembers it).
	HumanTyped bool
	// AtRest reads the agent's transcript: true when its last turn ended and no call is pending. Asked only when its
	// hooks have not reported in this run.
	AtRest func() bool
	// Fresh: the owner started this agent for this message, so its prompt is empty but for what the watch saw.
	Fresh bool
	// ClearConfirmed: the developer chose, with an explicit action, to empty the prompt before the message.
	ClearConfirmed bool
}

// clearInputKey is the key that empties the agent's whole input; Ctrl+U (one line) for the agents whose Ctrl+C is not known.
func clearInputKey(agent string) string {
	if agent == molten.AgentIdClaude || agent == molten.AgentIdCodex {
		return keyClearInput
	}
	return keyClearLine
}

// TypeOwnMessage types a message into MoltenTerm's own session and submits it, or types nothing (see above).
func TypeOwnMessage(ctx context.Context, blockId string, text string, facts OwnPromptFacts) AgentInputResult {
	u := getRunningUpdater()
	if u == nil {
		return refusedCannotType()
	}
	return u.typeOwnMessage(ctx, blockId, cleanMessage(text), facts)
}

// WatchOwnPrompt tells onForeign when a human's text comes into (true) or leaves (false) the prompt of an own session's
// terminal, so that its owner can remember it across restarts; nil stops.
// A watch asked for before the updater runs (an owner looking at wavesrv's start) is kept and given to it when it does.
func WatchOwnPrompt(blockId string, onForeign func(foreign bool)) {
	keepOwnWatch(blockId, onForeign)
	u := getRunningUpdater()
	if u == nil || u.env.WatchOwn == nil {
		return
	}
	u.env.WatchOwn(blockId, onForeign)
}

var ownWatchLock sync.Mutex
var ownWatches = map[string]func(bool){}

func keepOwnWatch(blockId string, onForeign func(bool)) {
	ownWatchLock.Lock()
	defer ownWatchLock.Unlock()
	if onForeign == nil {
		delete(ownWatches, blockId)
		return
	}
	ownWatches[blockId] = onForeign
}

func keptOwnWatches() map[string]func(bool) {
	ownWatchLock.Lock()
	defer ownWatchLock.Unlock()
	rtn := make(map[string]func(bool), len(ownWatches))
	for id, fn := range ownWatches {
		rtn[id] = fn
	}
	return rtn
}

func (u *Updater) typeOwnMessage(ctx context.Context, blockId string, text string, facts OwnPromptFacts) AgentInputResult {
	if text == "" || utf8.RuneCountInString(text) > MaxOwnSessionText {
		return refused(InputReasonUnknownAction, uimsg.Make("termupdate.line.none"), "There is no line to type: nothing was typed.")
	}
	if !u.begin(blockId) {
		return refusedBusy()
	}
	defer u.end(blockId)
	st, out := u.inspect(ctx, blockId)
	if out != nil {
		return u.unreadable(blockId, out)
	}
	if st.adapter == nil {
		if st.busy != "" {
			return refusedNotForeground(st.busy, "")
		}
		return refusedNoAgent("")
	}
	agent, name := st.agent.Agent, st.adapter.Name()
	base := func(r AgentInputResult) AgentInputResult {
		r.Agent, r.AgentName = agent, name
		return r
	}
	if blocker := u.foregroundBlocker(st.agent, st.shell.Pid); blocker != "" {
		return base(refusedBlocked(blocker, name))
	}
	// The agent at rest, asked again right before each key that could cut or answer something: a turn a background
	// task started meanwhile is never interrupted, and a question it asks is never answered.
	atRest := func() AgentInputResult {
		if run, ok := u.env.AgentRun(blockId); ok && run.Running {
			switch run.State {
			case molten.AgentStateWaiting:
				return base(refusedWaiting(name))
			case molten.AgentStateWorking:
				return base(refused(InputReasonWorking, uimsg.Make("termupdate.line.working", "agent", name),
					fmt.Sprintf("%s is working: wait for its turn to end.", name)))
			}
		}
		if !u.inputState(blockId).Precise && (facts.AtRest == nil || !facts.AtRest()) {
			return base(refused(InputReasonUnsettled, uimsg.Make("termupdate.line.unsettled", "agent", name),
				fmt.Sprintf("%s's state is not known yet: nothing was typed.", name)))
		}
		return AgentInputResult{}
	}
	if r := atRest(); r.Result != "" {
		return r
	}
	in := u.inputState(blockId)
	// Known: the watch saw the prompt emptied since; a session MoltenTerm just started has an empty prompt too.
	known := in.Known || facts.Fresh
	clear := false
	switch {
	case facts.ClearConfirmed:
		// The developer chose, in his layer, to empty the prompt: whatever is there goes, nothing of it is sent.
		clear = true
	case in.Foreign || (facts.HumanTyped && !in.Known):
		return base(refused(InputReasonHumanDraft, uimsg.Make("termupdate.line.humandraft", "agent", name),
			fmt.Sprintf("Text typed in %s's terminal waits in its prompt: nothing was typed.", name)))
	case !known:
		// After a restart the prompt may hold anything: it is never emptied on a guess, nor sent with the message.
		return base(refused(InputReasonUnknownPrompt, uimsg.Make("termupdate.line.unknownprompt", "agent", name),
			fmt.Sprintf("%s's prompt may hold text MoltenTerm did not see: nothing was typed.", name)))
	case in.Own:
		clear = true
	}
	send := func(steps ...string) AgentInputResult {
		sent, err := u.sendSteps(blockId, st.agent, st.shell.Pid, steps, true)
		if err != nil {
			return base(refusedNotTaken(err))
		}
		if !sent {
			return base(refusedGone(name))
		}
		return AgentInputResult{}
	}
	if clear {
		// Asked again right before the key: Ctrl+C would interrupt a turn that started meanwhile.
		if r := atRest(); r.Result != "" {
			return r
		}
		if r := send(clearInputKey(agent)); r.Result != "" {
			return r
		}
	}
	if r := send(pasteStart + text + pasteEnd); r.Result != "" {
		return r
	}
	// Not at rest any more: the line stays as MoltenTerm's own, which the next try empties first.
	if r := atRest(); r.Result != "" {
		return r
	}
	// A human typed between the paste and Enter: Enter would send their text with the message. It waits, and says so.
	if u.inputState(blockId).Foreign {
		return base(refused(InputReasonHumanDraft, uimsg.Make("termupdate.line.humandraft", "agent", name),
			fmt.Sprintf("Text was typed in %s's terminal while the message was on its way: Enter was not pressed.", name)))
	}
	if r := send("\r"); r.Result != "" {
		return r
	}
	rtn := sentResult(uimsg.Make("termupdate.line.sent", "agent", name), fmt.Sprintf("Sent to %s.", name))
	rtn.Submitted = true
	return base(rtn)
}
