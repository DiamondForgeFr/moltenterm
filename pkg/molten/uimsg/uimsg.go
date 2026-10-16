// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package uimsg carries the sentences wavesrv hands MoltenTerm's windows as a code plus details, so that the window
// words them in the interface language (#656, after #589 and #652). The English stays beside the code: it is what
// logs, agents and the `molten` CLI read, and what a window shows for a code it does not know.
//
// A result field a window shows (Message, Error, Detail, Reason...) gets a sibling *Text field named after it plus
// "Text" (MessageText, json "messagetext"); uimsg_test.go fails on a UI-facing struct that lacks one. An error a window
// shows is an *Error: the molten routes (pkg/molten/localroute) send its code to the windows with the English.
package uimsg

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// WireMark starts the code of an error sent to a window, followed by the Text's JSON, a newline and the English. Must
// match frontend/moltenterm-shell/i18n/server-text.ts.
const WireMark = "uimsg:"

// Text is a sentence for a window by its code: the window words it under the key server.<Code> of its locales, with Vars
// as the placeholders. Vars hold data (names, paths, counts, a tool's own output), never sentences of ours.
type Text struct {
	Code string            `json:"code"`
	Vars map[string]string `json:"vars,omitempty"`
	// Parts are placeholders that are sentences of ours (a duration, a state, the rest of a list): the window words
	// each one first, then puts it in its placeholder (#750).
	Parts map[string]*Text `json:"parts,omitempty"`
}

// Make is the Text of code with its vars as name, value pairs. The code must be a string literal, so that the guard
// test finds it and checks the locales have its key.
func Make(code string, pairs ...string) *Text {
	rtn := &Text{Code: code}
	for i := 0; i+1 < len(pairs); i += 2 {
		if rtn.Vars == nil {
			rtn.Vars = make(map[string]string)
		}
		rtn.Vars[pairs[i]] = pairs[i+1]
	}
	return rtn
}

// With sets the placeholder name to part, worded by the window; a nil part leaves the Text unchanged.
func (t *Text) With(name string, part *Text) *Text {
	if part == nil {
		return t
	}
	if t.Parts == nil {
		t.Parts = make(map[string]*Text)
	}
	t.Parts[name] = part
	return t
}

// Error is an error a window words by its Text; Error() is the English.
type Error struct {
	Text    *Text
	Message string
	// Err is the cause, for errors.Is and errors.As.
	Err error
}

func (e *Error) Error() string {
	return e.Message
}

func (e *Error) Unwrap() error {
	return e.Err
}

// Errorf is an error with text's code and the English of format; a %w verb wraps its cause.
func Errorf(text *Text, format string, args ...any) error {
	err := fmt.Errorf(format, args...)
	return &Error{Text: text, Message: err.Error(), Err: errors.Unwrap(err)}
}

// TextOf is the Text of the first coded error in err's chain, nil when none carries one.
func TextOf(err error) *Text {
	var coded *Error
	if !errors.As(err, &coded) {
		return nil
	}
	return coded.Text
}

// Detail is err's English for a "detail" var: "" for nil.
func Detail(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Wire is err as a window receives it: the code first when err carries one, then the English.
func Wire(err error) string {
	if err == nil {
		return ""
	}
	text := TextOf(err)
	if text == nil || text.Code == "" {
		return err.Error()
	}
	raw, jerr := json.Marshal(text)
	if jerr != nil {
		return err.Error()
	}
	return WireMark + string(raw) + "\n" + err.Error()
}

// Unwire splits a wired error back into its Text and English (tests, and Go callers that relay a window's error).
func Unwire(s string) (*Text, string) {
	idx := strings.Index(s, WireMark)
	if idx < 0 {
		return nil, s
	}
	rest := s[idx+len(WireMark):]
	nl := strings.IndexByte(rest, '\n')
	if nl < 0 {
		return nil, s
	}
	var text Text
	if err := json.Unmarshal([]byte(rest[:nl]), &text); err != nil {
		return nil, s
	}
	return &text, s[:idx] + rest[nl+1:]
}
