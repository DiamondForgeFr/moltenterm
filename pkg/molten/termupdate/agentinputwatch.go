// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

type paneInput struct {
	// run: the agent run these facts belong to (its start), so a new agent starts with nothing known.
	run     int64
	draft   bool
	inPaste bool
	mode    string
	modes   []string
}

type inputWatch struct {
	lock    sync.Mutex
	panes   map[string]*paneInput
	runOf   func(blockId string) (molten.AgentRunInfo, bool)
	precise func(blockId string) bool
}

func makeInputWatch(runOf func(string) (molten.AgentRunInfo, bool), precise func(string) bool) *inputWatch {
	return &inputWatch{panes: map[string]*paneInput{}, runOf: runOf, precise: precise}
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
	w.lock.Lock()
	defer w.lock.Unlock()
	p := w.paneLocked(blockId, run.Started)
	p.draft, p.inPaste = ScanDraft(data, p.draft, p.inPaste)
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
	return AgentInputState{Mode: p.mode, Modes: append([]string(nil), p.modes...), Draft: p.draft || !precise}
}
