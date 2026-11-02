// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The refusals the typing paths share, each with its code (#656): the windows word them in the interface language
// (frontend/moltenterm-shell/termupdate/termupdate-text.ts), the English stays for agents and logs. A mode travels as
// its id (mode, target) so that the window shows its own label.

func refused(reason string, text *uimsg.Text, message string) AgentInputResult {
	return AgentInputResult{Result: InputRefused, Reason: reason, Message: message, MessageText: text}
}

func sentResult(text *uimsg.Text, message string) AgentInputResult {
	return AgentInputResult{Result: InputSent, Message: message, MessageText: text}
}

func refusedBusy() AgentInputResult {
	return refused(InputReasonBusy, uimsg.Make("termupdate.input.busy"), "MoltenTerm is already typing in this terminal: try again in a moment.")
}

func refusedCannotType() AgentInputResult {
	return refused(InputReasonUnavailable, uimsg.Make("termupdate.input.cannottype"), "MoltenTerm cannot type in terminals yet: nothing was typed.")
}

// refusedUnreadable: the terminal could not be inspected (inspect's outcome), so nothing was typed.
func refusedUnreadable(out *Outcome) AgentInputResult {
	english := out.Message + " Nothing was typed."
	code := ""
	var detail string
	if out.MessageText != nil {
		code, detail = out.MessageText.Code, out.MessageText.Vars["detail"]
	}
	switch code {
	case "termupdate.unreadable":
		return refused(InputReasonUnavailable, uimsg.Make("termupdate.input.unreadable", "detail", detail), english)
	case "termupdate.notlocal":
		return refused(InputReasonUnavailable, uimsg.Make("termupdate.input.notlocal"), english)
	case "termupdate.cannotsee":
		return refused(InputReasonUnavailable, uimsg.Make("termupdate.input.cannotsee"), english)
	case "termupdate.shellended", "termupdate.terminalgone":
		return refusedTerminalGone()
	}
	return refused(InputReasonUnavailable, nil, english)
}

// refusedNotForeground: program holds the terminal instead of agent ("" when the agent is not known).
func refusedNotForeground(program string, agent string) AgentInputResult {
	var rtn AgentInputResult
	if agent == "" {
		rtn = refused(InputReasonNotForeground, uimsg.Make("termupdate.input.notforegroundany", "program", program),
			fmt.Sprintf("%s is in the foreground of this terminal, not the agent: nothing was typed.", program))
	} else {
		rtn = refused(InputReasonNotForeground, uimsg.Make("termupdate.input.notforeground", "program", program, "agent", agent),
			fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", program, agent))
	}
	rtn.Program = program
	return rtn
}

func refusedNoAgent(agent string) AgentInputResult {
	if agent == "" {
		return refused(InputReasonNoAgent, uimsg.Make("termupdate.input.noagentany"), "The agent no longer runs in this terminal: nothing was typed.")
	}
	return refused(InputReasonNoAgent, uimsg.Make("termupdate.input.noagent", "agent", agent),
		fmt.Sprintf("%s no longer runs in this terminal: nothing was typed.", agent))
}

func refusedGone(name string) AgentInputResult {
	return refused(InputReasonNotForeground, uimsg.Make("termupdate.input.gone", "agent", name),
		fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed.", name))
}

// refusedBlocked: blocker runs in the foreground instead of the agent named name.
func refusedBlocked(blocker string, name string) AgentInputResult {
	r := refusedNotForeground(blocker, name)
	if blocker == name {
		r = refusedGone(name)
		r.Program = blocker
	}
	return r
}

// refusedTerminalGone: the terminal is closed or its shell ended, whatever the agent's run record says (#1024).
func refusedTerminalGone() AgentInputResult {
	return refused(InputReasonTerminalGone, uimsg.Make("termupdate.input.terminalgone"),
		"The agent's terminal is closed or its shell ended: nothing was typed.")
}

func refusedNotTaken(err error) AgentInputResult {
	if errors.Is(err, ErrTerminalGone) || errors.Is(err, ErrNoController) {
		return refusedTerminalGone()
	}
	return refused(InputReasonUnavailable, uimsg.Make("termupdate.input.nottaken", "detail", uimsg.Detail(err)),
		fmt.Sprintf("The terminal did not take the input: %v", err))
}

func refusedWaiting(name string) AgentInputResult {
	r := refused(InputReasonWaiting, uimsg.Make("termupdate.input.waiting", "agent", name),
		fmt.Sprintf("%s is waiting for your answer: answer it first.", name))
	r.Offer = OfferGoto
	return r
}

// The outcomes of inspecting a terminal, before Update terminal, a restart or typing.

func outcomeUnreadable(err error) *Outcome {
	return &Outcome{Status: StatusUnavailable, MessageText: uimsg.Make("termupdate.unreadable", "detail", uimsg.Detail(err)),
		Message: fmt.Sprintf("This terminal cannot be read: %v", err)}
}

func outcomeNotLocal() *Outcome {
	return &Outcome{Status: StatusUnavailable, MessageText: uimsg.Make("termupdate.notlocal"), Message: "Only a local terminal's shell can be updated."}
}

func outcomeCannotSee() *Outcome {
	return &Outcome{Status: StatusUnavailable, MessageText: uimsg.Make("termupdate.cannotsee"),
		Message: "MoltenTerm cannot see what runs in this terminal on this system."}
}

func outcomeShellEnded() *Outcome {
	return &Outcome{Status: StatusUnavailable, MessageText: uimsg.Make("termupdate.shellended"), Message: "This terminal's shell has ended."}
}

func outcomeTerminalGone() *Outcome {
	return &Outcome{Status: StatusUnavailable, MessageText: uimsg.Make("termupdate.terminalgone"), Message: "This terminal was closed."}
}

func isNotLocal(out *Outcome) bool {
	return out != nil && out.MessageText != nil && out.MessageText.Code == "termupdate.notlocal"
}

// pick is the text of the action that asked for an agent restart: Update terminal, or Restart with current settings.
func (t restartTexts) pick(update *uimsg.Text, restart *uimsg.Text) *uimsg.Text {
	if t.restart {
		return restart
	}
	return update
}
