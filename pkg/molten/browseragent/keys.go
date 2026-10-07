// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The key action's syntax is Claude in Chrome's: space-separated chords such as "Enter", "cmd+a" or
// "ctrl+shift+ArrowLeft". Each chord becomes a key down and a key up through Input.dispatchKeyEvent, delivered to the
// page only (DS-BRW-016).

const (
	modAlt   = 1
	modCtrl  = 2
	modMeta  = 4
	modShift = 8

	// One call presses at most this many keys, repeats included.
	maxKeyPresses = 1000
)

// keyChord is one key press with its modifiers, ready for Input.dispatchKeyEvent.
type keyChord struct {
	// name is the canonical spelling shown on the control bar (never typed text: only key names reach it).
	name      string
	key       string
	code      string
	keyCode   int
	text      string
	modifiers int
	// commands are the editing commands macOS needs for its shortcuts (cmd+a); clipboard commands are never sent.
	commands []string
}

type namedKey struct {
	key     string
	code    string
	keyCode int
	text    string
}

var namedKeys = map[string]namedKey{
	"enter":      {"Enter", "Enter", 13, "\r"},
	"return":     {"Enter", "Enter", 13, "\r"},
	"tab":        {"Tab", "Tab", 9, ""},
	"backspace":  {"Backspace", "Backspace", 8, ""},
	"delete":     {"Delete", "Delete", 46, ""},
	"del":        {"Delete", "Delete", 46, ""},
	"escape":     {"Escape", "Escape", 27, ""},
	"esc":        {"Escape", "Escape", 27, ""},
	"space":      {" ", "Space", 32, " "},
	"arrowup":    {"ArrowUp", "ArrowUp", 38, ""},
	"up":         {"ArrowUp", "ArrowUp", 38, ""},
	"arrowdown":  {"ArrowDown", "ArrowDown", 40, ""},
	"down":       {"ArrowDown", "ArrowDown", 40, ""},
	"arrowleft":  {"ArrowLeft", "ArrowLeft", 37, ""},
	"left":       {"ArrowLeft", "ArrowLeft", 37, ""},
	"arrowright": {"ArrowRight", "ArrowRight", 39, ""},
	"right":      {"ArrowRight", "ArrowRight", 39, ""},
	"home":       {"Home", "Home", 36, ""},
	"end":        {"End", "End", 35, ""},
	"pageup":     {"PageUp", "PageUp", 33, ""},
	"pagedown":   {"PageDown", "PageDown", 34, ""},
	"insert":     {"Insert", "Insert", 45, ""},
	"f1":         {"F1", "F1", 112, ""},
	"f2":         {"F2", "F2", 113, ""},
	"f3":         {"F3", "F3", 114, ""},
	"f4":         {"F4", "F4", 115, ""},
	"f5":         {"F5", "F5", 116, ""},
	"f6":         {"F6", "F6", 117, ""},
	"f7":         {"F7", "F7", 118, ""},
	"f8":         {"F8", "F8", 119, ""},
	"f9":         {"F9", "F9", 120, ""},
	"f10":        {"F10", "F10", 121, ""},
	"f11":        {"F11", "F11", 122, ""},
	"f12":        {"F12", "F12", 123, ""},
}

var punctuationKeys = map[rune]struct {
	code    string
	keyCode int
}{
	'-': {"Minus", 189}, '=': {"Equal", 187}, '[': {"BracketLeft", 219}, ']': {"BracketRight", 221},
	'\\': {"Backslash", 220}, ';': {"Semicolon", 186}, '\'': {"Quote", 222}, ',': {"Comma", 188},
	'.': {"Period", 190}, '/': {"Slash", 191}, '`': {"Backquote", 192},
}

var modifierNames = map[string]int{
	"ctrl": modCtrl, "control": modCtrl,
	"shift": modShift,
	"alt":   modAlt, "option": modAlt, "opt": modAlt,
	"cmd": modMeta, "meta": modMeta, "command": modMeta, "super": modMeta, "win": modMeta, "windows": modMeta,
}

// parseModifiers reads "ctrl+shift" into the DevTools bitmask; ok is false for an unknown name.
func parseModifiers(text string) (int, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, true
	}
	mods := 0
	for _, part := range strings.Split(text, "+") {
		bit, ok := modifierNames[strings.ToLower(strings.TrimSpace(part))]
		if !ok {
			return 0, false
		}
		mods |= bit
	}
	return mods, true
}

// splitChord separates "ctrl+shift+a" into its modifiers and its key; a final "+" is the plus key ("ctrl++").
func splitChord(chord string) ([]string, string) {
	if chord == "+" {
		return nil, "+"
	}
	if strings.HasSuffix(chord, "++") {
		return strings.Split(strings.TrimSuffix(chord, "++"), "+"), "+"
	}
	parts := strings.Split(chord, "+")
	return parts[:len(parts)-1], parts[len(parts)-1]
}

// parseChord reads one chord; ok is false for an unknown modifier or key.
func parseChord(chord string, macCommands bool) (keyChord, bool) {
	modNames, keyName := splitChord(chord)
	mods := 0
	var canon []string
	for _, name := range modNames {
		bit, ok := modifierNames[strings.ToLower(strings.TrimSpace(name))]
		if !ok {
			return keyChord{}, false
		}
		mods |= bit
	}
	for _, m := range []struct {
		bit  int
		name string
	}{{modCtrl, "ctrl"}, {modAlt, "alt"}, {modShift, "shift"}, {modMeta, "cmd"}} {
		if mods&m.bit != 0 {
			canon = append(canon, m.name)
		}
	}
	rtn := keyChord{modifiers: mods}
	if named, ok := namedKeys[strings.ToLower(keyName)]; ok {
		rtn.key, rtn.code, rtn.keyCode, rtn.text = named.key, named.code, named.keyCode, named.text
		canon = append(canon, named.code)
		if named.key == " " {
			canon[len(canon)-1] = "Space"
		}
	} else if utf8.RuneCountInString(keyName) == 1 {
		r, _ := utf8.DecodeRuneInString(keyName)
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return keyChord{}, false
		}
		ch := string(r)
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			lower := unicode.ToLower(r)
			rtn.code = "Key" + string(unicode.ToUpper(r))
			rtn.keyCode = int(unicode.ToUpper(r))
			ch = string(lower)
			if mods&modShift != 0 || (r >= 'A' && r <= 'Z') {
				ch = string(unicode.ToUpper(r))
			}
		case r >= '0' && r <= '9':
			rtn.code = "Digit" + ch
			rtn.keyCode = int(r)
		default:
			if p, ok := punctuationKeys[r]; ok {
				rtn.code, rtn.keyCode = p.code, p.keyCode
			}
		}
		rtn.key = ch
		rtn.text = ch
		canon = append(canon, strings.ToLower(ch))
		if r >= 'A' && r <= 'Z' && mods&modShift == 0 {
			canon[len(canon)-1] = ch
		}
	} else {
		return keyChord{}, false
	}
	// A shortcut types nothing; Alt changes the character on macOS, so it types nothing either rather than a guess.
	if mods&(modCtrl|modMeta|modAlt) != 0 {
		rtn.text = ""
	}
	if macCommands && mods&modMeta != 0 && mods&modCtrl == 0 {
		rtn.commands = macEditingCommands(strings.ToLower(rtn.key), mods&modShift != 0)
	}
	rtn.name = strings.Join(canon, "+")
	return rtn, true
}

// macEditingCommands: Chromium on macOS runs its edit shortcuts as commands, which DevTools input must name. Only
// selection and undo: copy, cut and paste would reach the user's clipboard.
func macEditingCommands(key string, shift bool) []string {
	switch {
	case key == "a" && !shift:
		return []string{"selectAll"}
	case key == "z" && !shift:
		return []string{"undo"}
	case key == "z" && shift:
		return []string{"redo"}
	}
	return nil
}

// parseKeys reads the key action's text: space-separated chords. ok is false when any chord is unknown or the text is
// empty.
func parseKeys(text string, macCommands bool) ([]keyChord, bool) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil, false
	}
	chords := make([]keyChord, 0, len(fields))
	for _, f := range fields {
		chord, ok := parseChord(f, macCommands)
		if !ok {
			return nil, false
		}
		chords = append(chords, chord)
	}
	return chords, true
}

// isClipboard: copy, cut and paste shortcuts, refused on every system (FR-BRW-010 AC6). On Windows and Linux the
// page's engine runs them from the key itself, so leaving out the editing commands is not enough.
func (c keyChord) isClipboard() bool {
	k := strings.ToLower(c.key)
	if c.modifiers&(modCtrl|modMeta) != 0 && (k == "c" || k == "x" || k == "v") {
		return true
	}
	switch c.key {
	case "Insert":
		return c.modifiers&(modCtrl|modShift) != 0
	case "Delete":
		return c.modifiers&modShift != 0
	}
	return false
}

// producesText: the chord would type a character into the focused field.
func (c keyChord) producesText() bool {
	return c.text != "" && c.key != "Enter"
}

func (c keyChord) isEnter() bool {
	return c.key == "Enter"
}

func (c keyChord) isSpace() bool {
	return c.key == " "
}

// keyEvents are the DevTools events of one chord: a key down (rawKeyDown when it types nothing) and a key up.
func (c keyChord) keyEvents() []map[string]any {
	down := map[string]any{
		"type":                  "rawKeyDown",
		"key":                   c.key,
		"code":                  c.code,
		"windowsVirtualKeyCode": c.keyCode,
		"modifiers":             c.modifiers,
	}
	if c.text != "" {
		down["type"] = "keyDown"
		down["text"] = c.text
		down["unmodifiedText"] = c.text
	}
	if len(c.commands) > 0 {
		down["commands"] = c.commands
	}
	up := map[string]any{
		"type":                  "keyUp",
		"key":                   c.key,
		"code":                  c.code,
		"windowsVirtualKeyCode": c.keyCode,
		"modifiers":             c.modifiers,
	}
	return []map[string]any{down, up}
}
