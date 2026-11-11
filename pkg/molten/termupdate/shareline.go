// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package termupdate

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Share and tell (FR-BRW-011, DS-BRW-017): the browser panel's line about a shared tab is typed into the agent's prompt
// with the guarantees of the command panel's agent input (agentinput.go), and never submitted. The line is built in
// wavesrv from the panel's own copy of the tab (pkg/molten/browseragent), never taken from a window.

const (
	pasteStart = "\x1b[200~"
	pasteEnd   = "\x1b[201~"
	// A line longer than this (in characters) is not a share or hand-off line.
	maxTypedLine = 600
	// MaxTypedMessage is the longest message the developer writes to an agent in a field of MoltenTerm (Brokk's), in
	// characters: his whole text, never cut (#2236). A hand-off line is a short pointer and keeps maxTypedLine.
	MaxTypedMessage = 4000
)

var runningLock sync.Mutex
var runningUpdater *Updater

func setRunningUpdater(u *Updater) {
	runningLock.Lock()
	defer runningLock.Unlock()
	runningUpdater = u
}

func getRunningUpdater() *Updater {
	runningLock.Lock()
	defer runningLock.Unlock()
	return runningUpdater
}

// TypeShareLine types line into the prompt of the agent running in blockId, without Enter; wavesrv's browser agent
// sessions call it.
func TypeShareLine(ctx context.Context, blockId string, line string) AgentInputResult {
	u := getRunningUpdater()
	if u == nil {
		return refusedCannotType()
	}
	return u.TypeLine(ctx, blockId, line)
}

// TypeHandoffLine types the prompt of a handoff between agents (FR-CONT-015, DS-CONT-029) through the same guarded path,
// and submits it with Enter when no unsent draft of the user's may be in the prompt: a draft would be sent with it.
// Submitted tells which happened.
func TypeHandoffLine(ctx context.Context, blockId string, line string) AgentInputResult {
	u := getRunningUpdater()
	if u == nil {
		return refusedCannotType()
	}
	return u.typeLine(ctx, blockId, line, true)
}

// TypeMessageLine types a message the developer wrote to the agent (Brokk's field, FR-BOSS-009) through the hand-off's
// guarded path, submitted the same way, up to MaxTypedMessage characters rather than a hand-off's short line.
func TypeMessageLine(ctx context.Context, blockId string, line string) AgentInputResult {
	u := getRunningUpdater()
	if u == nil {
		return refusedCannotType()
	}
	return u.typeLineUpTo(ctx, blockId, line, true, MaxTypedMessage)
}

// AgentTakesLine tells, without typing, whether the agent in blockId would take a typed line with Enter now: it runs,
// its hooks report precise states, and no draft is in its prompt. Brokk's session waits for it before typing the first
// message into an agent it just started (#2028).
func AgentTakesLine(blockId string) bool {
	u := getRunningUpdater()
	if u == nil {
		return false
	}
	return !u.inputState(blockId).Draft
}

// cleanTypedLine keeps one printable line: no control character can end the paste, add a newline or press a key.
func cleanTypedLine(line string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, line))
}

// TypeLine types one line as a bracketed paste with no Enter: the agent must be the shell's foreground program, and
// neither working nor waiting for an answer, which the line would interrupt or answer. A draft the user typed stays:
// the line is added after it.
func (u *Updater) TypeLine(ctx context.Context, blockId string, line string) AgentInputResult {
	return u.typeLine(ctx, blockId, line, false)
}

// typeLine types the line; submit: press Enter after it when the prompt holds no draft the user may still be writing.
func (u *Updater) typeLine(ctx context.Context, blockId string, line string, submit bool) AgentInputResult {
	return u.typeLineUpTo(ctx, blockId, line, submit, maxTypedLine)
}

// typeLineUpTo is typeLine for a line of at most limit characters.
func (u *Updater) typeLineUpTo(ctx context.Context, blockId string, line string, submit bool, limit int) AgentInputResult {
	line = cleanTypedLine(line)
	if line == "" || utf8.RuneCountInString(line) > limit {
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
	steps := []string{pasteStart + line + pasteEnd}
	enter := submit && !u.inputState(blockId).Draft
	if enter {
		steps = append(steps, "\r")
	}
	sent, err := u.sendToForegroundAgent(blockId, st.agent, st.shell.Pid, steps)
	if err != nil {
		return base(refusedNotTaken(err))
	}
	if !sent {
		return base(refusedGone(name))
	}
	if enter {
		rtn := sentResult(uimsg.Make("termupdate.line.sent", "agent", name), fmt.Sprintf("Sent to %s.", name))
		rtn.Submitted = true
		return base(rtn)
	}
	if submit {
		return base(sentResult(uimsg.Make("termupdate.line.typeddraft", "agent", name),
			fmt.Sprintf("Typed in %s's prompt without Enter: the user may have an unsent message there.", name)))
	}
	return base(sentResult(uimsg.Make("termupdate.line.typed", "agent", name),
		fmt.Sprintf("Typed in %s's prompt: add what to do and press Enter.", name)))
}
