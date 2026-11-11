// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package termupdate

import (
	"context"
	"fmt"
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
//   - text MoltenTerm left there, or a prompt the watch has not followed since it was last empty, is cleared first, so a
//     retry never stacks the message;
//   - Enter is pressed only when the agent is at rest at its prompt: its hooks report its states, or its transcript
//     shows no call pending (a permission question is a pending call), so the message never answers a question;
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

	// Ctrl+C empties the whole input of Claude Code and Codex, a multi-line paste included, and does nothing else while
	// they wait at their prompt with text in it.
	keyClearInput = "\x03"
)

// OwnPromptFacts is what the session's owner knows that the watch cannot.
type OwnPromptFacts struct {
	// HumanTyped: a human's text was left in the prompt before this wavesrv started (the owner remembers it).
	HumanTyped bool
	// AtRest reads the agent's transcript: true when it sits at its prompt with no call pending. Asked only when its
	// hooks have not reported in this run.
	AtRest func() bool
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
func WatchOwnPrompt(blockId string, onForeign func(foreign bool)) {
	u := getRunningUpdater()
	if u == nil || u.env.WatchOwn == nil {
		return
	}
	u.env.WatchOwn(blockId, onForeign)
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
	if run, ok := u.env.AgentRun(blockId); ok && run.Running {
		switch run.State {
		case molten.AgentStateWaiting:
			return base(refusedWaiting(name))
		case molten.AgentStateWorking:
			return base(refused(InputReasonWorking, uimsg.Make("termupdate.line.working", "agent", name),
				fmt.Sprintf("%s is working: wait for its turn to end.", name)))
		}
	}
	in := u.inputState(blockId)
	if in.Foreign || (facts.HumanTyped && !in.Known) {
		return base(refused(InputReasonHumanDraft, uimsg.Make("termupdate.line.humandraft", "agent", name),
			fmt.Sprintf("Text typed in %s's terminal waits in its prompt: nothing was typed.", name)))
	}
	if !in.Precise && (facts.AtRest == nil || !facts.AtRest()) {
		return base(refused(InputReasonUnsettled, uimsg.Make("termupdate.line.unsettled", "agent", name),
			fmt.Sprintf("%s's state is not known yet: nothing was typed.", name)))
	}
	var steps []string
	if in.Own || !in.Known {
		steps = append(steps, clearInputKey(agent))
	}
	steps = append(steps, pasteStart+text+pasteEnd, "\r")
	sent, err := u.sendToForegroundAgent(blockId, st.agent, st.shell.Pid, steps)
	if err != nil {
		return base(refusedNotTaken(err))
	}
	if !sent {
		return base(refusedGone(name))
	}
	rtn := sentResult(uimsg.Make("termupdate.line.sent", "agent", name), fmt.Sprintf("Sent to %s.", name))
	rtn.Submitted = true
	return base(rtn)
}
