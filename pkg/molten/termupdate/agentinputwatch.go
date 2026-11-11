// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package termupdate

import (
	"bytes"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What moltenagentinput knows of a terminal's agent besides its process and state (DS-SHELL-087):
//   - a possible unsent draft: the user typed something since the last Enter, Ctrl+U or Ctrl+C. An agent without
//     precise states (no hooks) is always assumed to hold one, since its input line cannot be told apart from a
//     question it asks;
//   - Claude Code's permission mode, read from the footer it draws ("⏸ plan mode on (shift+tab to cycle)"). A mode
//     never drawn in this run is unknown.

// Claude Code's footer, by mode; "? for shortcuts" shows only in the default mode.
var claudeModeMarks = []struct {
	text []byte
	mode string
}{
	{[]byte("plan mode on"), ModePlan},
	{[]byte("accept edits on"), ModeAcceptEdits},
	{[]byte("bypass permissions on"), ModeBypassPermissions},
	{[]byte("auto mode on"), ModeAuto},
	{[]byte("? for shortcuts"), ModeDefault},
}

// Cheap first test on the raw output: most chunks carry none of the marks.
var claudeModeHints = [][]byte{[]byte(" on"), []byte("shortcuts")}

// stripEscapes drops terminal escape sequences (CSI, OSC, two-byte escapes), keeping the text.
func stripEscapes(data []byte) []byte {
	rtn := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c != 0x1b {
			rtn = append(rtn, c)
			continue
		}
		if i+1 >= len(data) {
			break
		}
		switch data[i+1] {
		case '[':
			j := i + 2
			for j < len(data) && (data[j] < 0x40 || data[j] > 0x7e) {
				j++
			}
			i = j
		case ']':
			j := i + 2
			for j < len(data) && data[j] != 0x07 && !(data[j] == 0x1b && j+1 < len(data) && data[j+1] == '\\') {
				j++
			}
			if j < len(data) && data[j] == 0x1b {
				j++
			}
			i = j
		default:
			i++
		}
	}
	return rtn
}

// ParseClaudeMode finds the permission mode a chunk of Claude Code's output draws last, "" for none.
func ParseClaudeMode(data []byte) string {
	hinted := false
	for _, hint := range claudeModeHints {
		if bytes.Contains(data, hint) {
			hinted = true
			break
		}
	}
	if !hinted {
		return ""
	}
	text := bytes.ToLower(stripEscapes(data))
	best, at := "", -1
	for _, m := range claudeModeMarks {
		if i := bytes.LastIndex(text, m.text); i > at {
			best, at = m.mode, i
		}
	}
	return best
}

// ScanDraft follows the input line through what is typed: printable text (a paste included) makes a draft; Enter
// sends it, Ctrl+U and Ctrl+C clear it. A newline inside a bracketed paste, or Alt+Enter, is part of the draft.
func ScanDraft(data []byte, draft bool, inPaste bool) (bool, bool) {
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == 0x1b:
			if i+1 >= len(data) {
				continue
			}
			next := data[i+1]
			if next == '\r' || next == '\n' {
				draft = true
				i++
				continue
			}
			if next != '[' && next != 'O' {
				i++
				continue
			}
			j := i + 2
			for j < len(data) && (data[j] < 0x40 || data[j] > 0x7e) {
				j++
			}
			if next == '[' && j < len(data) && data[j] == '~' {
				switch string(data[i+2 : j]) {
				case "200":
					inPaste = true
				case "201":
					inPaste = false
				}
			}
			i = j
		case c == '\r' || c == '\n':
			if !inPaste {
				draft = false
			}
		case c == 0x15 || c == 0x03:
			draft = false
		case c >= 0x20 && c != 0x7f:
			draft = true
		}
	}
	return draft, inPaste
}

// Whose text the draft is (#2257): what MoltenTerm types into its own session tells the watch the exact bytes first
// (expectOwn); any other input that writes text is someone else's: a human at the terminal, or a hand-off. A prompt is
// known only once the watch has seen it emptied (Enter, Ctrl+U, Ctrl+C): when the agent's run record started says
// nothing, since a hook can make that record after a restart, and what an earlier wavesrv saw is lost.

type paneInput struct {
	// run: the agent run these facts belong to (its start), so a new agent starts with nothing known.
	run     int64
	draft   bool
	inPaste bool
	mode    string
	modes   []string
	// foreign: some of the draft was typed by someone other than MoltenTerm.
	foreign bool
	// known: the watch saw this prompt emptied.
	known bool
}

// maxOwnPending bounds the chunks MoltenTerm said it would type into one terminal and that did not come through yet.
const maxOwnPending = 16

type inputWatch struct {
	lock    sync.Mutex
	panes   map[string]*paneInput
	runOf   func(blockId string) (molten.AgentRunInfo, bool)
	precise func(blockId string) bool
	// own: per terminal, the chunks MoltenTerm is about to type, in order.
	own map[string][][]byte
	// ownWatch: the terminals whose owner is told when a human's text comes into, or leaves, their prompt.
	ownWatch map[string]func(foreign bool)
}

func makeInputWatch(runOf func(string) (molten.AgentRunInfo, bool), precise func(string) bool) *inputWatch {
	return &inputWatch{
		panes:    map[string]*paneInput{},
		runOf:    runOf,
		precise:  precise,
		own:      map[string][][]byte{},
		ownWatch: map[string]func(bool){},
	}
}

// expectOwn says MoltenTerm types data into the terminal next; the returned func takes it back when it was not sent.
func (w *inputWatch) expectOwn(blockId string, data []byte) func() {
	chunk := append([]byte(nil), data...)
	w.lock.Lock()
	defer w.lock.Unlock()
	list := append(w.own[blockId], chunk)
	if len(list) > maxOwnPending {
		list = list[len(list)-maxOwnPending:]
	}
	w.own[blockId] = list
	return func() { w.dropOwn(blockId, chunk) }
}

func (w *inputWatch) dropOwn(blockId string, chunk []byte) {
	w.lock.Lock()
	defer w.lock.Unlock()
	list := w.own[blockId]
	for i, c := range list {
		if bytes.Equal(c, chunk) {
			w.own[blockId] = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(w.own[blockId]) == 0 {
		delete(w.own, blockId)
	}
}

// takeOwnLocked tells whether data is the next chunk MoltenTerm said it would type, and consumes it.
func (w *inputWatch) takeOwnLocked(blockId string, data []byte) bool {
	list := w.own[blockId]
	for i, c := range list {
		if !bytes.Equal(c, data) {
			continue
		}
		w.own[blockId] = append(list[:i:i], list[i+1:]...)
		if len(w.own[blockId]) == 0 {
			delete(w.own, blockId)
		}
		return true
	}
	return false
}

// watchOwn tells onForeign each time a human's text comes into the terminal's prompt (true), and each time the prompt
// is seen emptied (false). A human's text the watch already saw is told at once, so text typed before the owner
// registered is not lost.
func (w *inputWatch) watchOwn(blockId string, onForeign func(foreign bool)) {
	if seed := w.registerOwn(blockId, onForeign); seed {
		onForeign(true)
	}
}

func (w *inputWatch) registerOwn(blockId string, onForeign func(foreign bool)) bool {
	w.lock.Lock()
	defer w.lock.Unlock()
	if onForeign == nil {
		delete(w.ownWatch, blockId)
		return false
	}
	if _, already := w.ownWatch[blockId]; already {
		w.ownWatch[blockId] = onForeign
		return false
	}
	w.ownWatch[blockId] = onForeign
	p := w.panes[blockId]
	return p != nil && p.draft && p.foreign
}

// writesText: the input puts or removes text in the line (printable characters, Backspace, Ctrl+W, Ctrl+K...), not
// only moves or answers the terminal (escape sequences).
func writesText(data []byte) bool {
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c == 0x1b {
			if i+1 < len(data) && (data[i+1] == '[' || data[i+1] == 'O') {
				j := i + 2
				for j < len(data) && (data[j] < 0x40 || data[j] > 0x7e) {
					j++
				}
				i = j
			} else {
				i++
			}
			continue
		}
		if c == '\r' || c == '\n' || c == 0x15 || c == 0x03 {
			continue
		}
		return true
	}
	return false
}

func (w *inputWatch) paneLocked(blockId string, run int64) *paneInput {
	p := w.panes[blockId]
	if p == nil || p.run != run {
		p = &paneInput{run: run}
		w.panes[blockId] = p
	}
	return p
}

func (w *inputWatch) forget(blockId string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	delete(w.panes, blockId)
}

func (w *inputWatch) input(blockId string, data []byte) {
	run, ok := w.runOf(blockId)
	if !ok || !run.Running {
		w.forget(blockId)
		return
	}
	tell, foreign := w.inputLocked(blockId, run, data)
	if tell != nil {
		tell(foreign)
	}
}

// inputLocked applies the input; it returns the owner to tell when a human's text came into or left the prompt.
func (w *inputWatch) inputLocked(blockId string, run molten.AgentRunInfo, data []byte) (func(bool), bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	own := w.takeOwnLocked(blockId, data)
	p := w.paneLocked(blockId, run.Started)
	draft, inPaste := ScanDraft(data, p.draft, p.inPaste)
	p.inPaste = inPaste
	// Keys typed while the agent waits answer its own question ("1", "y" pick a choice without Enter): they leave the
	// prompt as it was, so a handoff to an empty prompt is still sent with Enter (#790).
	if run.State == molten.AgentStateWaiting {
		return nil, false
	}
	p.draft = draft
	was := p.foreign
	emptied := false
	switch {
	case !draft:
		p.foreign = false
		// Only a key that empties the line proves the prompt empty: a Backspace on a prompt not followed proves nothing.
		if bytes.ContainsAny(data, "\r\n\x15\x03") {
			p.known = true
			emptied = true
		}
	case !own && writesText(data):
		p.foreign = true
	}
	tell := w.ownWatch[blockId]
	switch {
	case p.foreign && !was:
		return tell, true
	case emptied:
		// The owner forgets a human's text only when the prompt was seen emptied, never because the watch knows nothing.
		return tell, false
	}
	return nil, false
}

func (w *inputWatch) output(blockId string, data []byte) {
	mode := ParseClaudeMode(data)
	if mode == "" {
		return
	}
	run, ok := w.runOf(blockId)
	if !ok || !run.Running || run.Agent != molten.AgentIdClaude {
		return
	}
	w.lock.Lock()
	defer w.lock.Unlock()
	p := w.paneLocked(blockId, run.Started)
	p.mode = mode
	if !slices.Contains(p.modes, mode) {
		p.modes = append(p.modes, mode)
	}
}

func (w *inputWatch) state(blockId string) AgentInputState {
	run, ok := w.runOf(blockId)
	if !ok || !run.Running {
		return AgentInputState{Draft: true}
	}
	precise := w.precise(blockId)
	w.lock.Lock()
	defer w.lock.Unlock()
	p := w.paneLocked(blockId, run.Started)
	return AgentInputState{
		Mode:    p.mode,
		Modes:   append([]string(nil), p.modes...),
		Draft:   p.draft || !precise,
		Foreign: p.draft && p.foreign,
		Own:     p.draft && !p.foreign,
		Known:   p.known,
		Precise: precise,
	}
}
