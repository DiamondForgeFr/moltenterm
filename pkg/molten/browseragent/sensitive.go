// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"fmt"
	"strings"
	"unicode"
)

// Sensitive actions (FR-BRW-010, DS-BRW-016, NFR-BRW-005): before an input action, emain describes its target with
// fixed code in MoltenTerm's isolated world (Molten.inspect), so the page's scripts cannot change the answer. These
// actions ask the user every time, and an answer is never remembered: typing into a password or payment field,
// submitting a form that holds one, opening a file chooser, and any download a controlled tab starts.

const (
	reasonSensitiveField = "sensitive-field"
	reasonSensitiveFill  = "sensitive-fill"
	reasonFrameField     = "frame-field"
	reasonSensitiveForm  = "sensitive-submit"
	reasonFileChooser    = "file-chooser"
	reasonDownload       = "download"

	maxLabelRunes = 40
)

// targetInfo is what Molten.inspect says of an element (emain/moltenterm-browseragent-policy.ts, inspectFunction).
type targetInfo struct {
	Found bool `json:"found"`
	// Kind is a role word for the bar: button, link, textbox, checkbox, radio, select, file, frame, element.
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Sensitive: a password, card or one-time code field.
	Sensitive bool `json:"sensitive"`
	// Editable: a field or contenteditable element the agent can type into.
	Editable bool `json:"editable"`
	// SubmitControl: clicking it (or Enter or Space on it) submits its form.
	SubmitControl bool `json:"submitcontrol"`
	// FormSensitive: the element's form holds a sensitive field.
	FormSensitive bool `json:"formsensitive"`
	// FileInput: a file input or the label of one, which opens the OS file chooser.
	FileInput bool `json:"fileinput"`
	// Frame: the element is a frame, whose content MoltenTerm cannot inspect.
	Frame bool       `json:"frame"`
	Link  bool       `json:"link"`
	Rect  *rectValue `json:"rect"`
}

type rectValue struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// unknownTarget stands for an element MoltenTerm could not inspect: typing there asks, as for a frame.
var unknownTarget = targetInfo{Found: false, Kind: "element", Frame: true}

// actionPromptText is what the bar asks: "<Agent> wants to <text> on <site>".
func actionPromptText(reason string) string {
	switch reason {
	case reasonSensitiveField:
		return "type into a password or payment field"
	case reasonSensitiveFill:
		return "fill in a password or payment field"
	case reasonFrameField:
		return "type into a field inside a frame, which MoltenTerm cannot check"
	case reasonSensitiveForm:
		return "submit a form with a password or payment field"
	case reasonFileChooser:
		return "open a file chooser"
	case reasonDownload:
		return "start a download"
	}
	return "do a sensitive action"
}

// clickReason: a left click on a submit control of a form holding a sensitive field, or on a file input, asks. Other
// buttons only open menus.
func clickReason(t targetInfo, button string) string {
	if button != "left" {
		return ""
	}
	if t.FileInput {
		return reasonFileChooser
	}
	if t.SubmitControl && t.FormSensitive {
		return reasonSensitiveForm
	}
	return ""
}

// typeReason: typing into the focused element asks when it is sensitive, or when focus is in a frame MoltenTerm cannot
// look into (card fields are often in one).
func typeReason(focused targetInfo) string {
	if focused.Sensitive {
		return reasonSensitiveField
	}
	if focused.Frame {
		return reasonFrameField
	}
	return ""
}

// keyReason: a key typing a character is typing; Enter submits the focused field's form; Enter and Space activate the
// focused button or file input.
func keyReason(focused targetInfo, chord keyChord) string {
	if chord.producesText() {
		if reason := typeReason(focused); reason != "" {
			return reason
		}
	}
	if !chord.isEnter() && !chord.isSpace() {
		return ""
	}
	if focused.FileInput {
		return reasonFileChooser
	}
	// Enter in any control of such a form submits it, a checkbox's included.
	if focused.FormSensitive && (focused.SubmitControl || chord.isEnter()) {
		return reasonSensitiveForm
	}
	if focused.Frame && chord.isEnter() {
		return reasonFrameField
	}
	return ""
}

// keyNeedsInspection: only these chords can be sensitive, so only they cost a look at the focused element.
func keyNeedsInspection(chord keyChord) bool {
	return chord.producesText() || chord.isEnter() || chord.isSpace()
}

// keyInspectParams: a key that only types a character needs the focused field's own kind, not its form or label (the
// lean look, which spares the page a layout on every key).
func keyInspectParams(chord keyChord) map[string]any {
	if chord.isEnter() || chord.isSpace() {
		return map[string]any{"focused": true}
	}
	return map[string]any{"focused": true, "lean": true}
}

// withTargetAt adds to a ref's element what a click at its centre would really hit, since another element may lie on
// top of it: the click asks when either one is sensitive.
func withTargetAt(ref targetInfo, at targetInfo) targetInfo {
	if !at.Found {
		return ref
	}
	ref.FileInput = ref.FileInput || at.FileInput
	ref.Link = ref.Link || at.Link
	if at.SubmitControl && at.FormSensitive {
		ref.SubmitControl, ref.FormSensitive = true, true
	}
	return ref
}

// cleanLabel keeps a label fit for the bar: one line of printable text, without quotes, cut short. It comes from the
// page, so it is shown in MoltenTerm's own words around it and never logged.
func cleanLabel(label string) string {
	label = strings.Map(func(r rune) rune {
		// Format characters (bidi overrides) would let a page reorder the bar's line around its label.
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '"' || r == '“' || r == '”' {
			return ' '
		}
		return r
	}, label)
	label = strings.Join(strings.Fields(label), " ")
	if runes := []rune(label); len(runes) > maxLabelRunes {
		label = strings.TrimSpace(string(runes[:maxLabelRunes-1])) + "…"
	}
	return label
}

var targetKinds = map[string]bool{
	"button": true, "link": true, "textbox": true, "checkbox": true, "radio": true, "select": true, "file": true,
	"frame": true, "element": true,
}

// describe names a target on the bar: `button "Sign in"`, or "" when it says nothing useful.
func (t targetInfo) describe() string {
	kind := t.Kind
	if !targetKinds[kind] {
		kind = "element"
	}
	label := cleanLabel(t.Label)
	if label == "" {
		if kind == "element" {
			return ""
		}
		return kind
	}
	return fmt.Sprintf("%s %q", kind, label)
}

// actionLine is the control bar's line for an action: the verb, then the target, else the point.
func actionLine(verb string, t targetInfo, x float64, y float64, hasPoint bool) string {
	if d := t.describe(); d != "" {
		return verb + " " + d
	}
	if hasPoint {
		return fmt.Sprintf("%s at (%d, %d)", verb, int(x), int(y))
	}
	return verb
}
