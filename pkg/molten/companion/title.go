// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxCommandRunes = 60

// Claude Code's internal markup, removed by tag name only: a prompt that holds other angle brackets (code, HTML)
// is kept as typed. These blocks carry no prompt of the user, so their content goes with the tags.
var titleMarkupTags = []string{
	"command-name", "command-message", "command-args",
	"local-command-stdout", "local-command-stderr", "local-command-caveat",
	"system-reminder", "user-prompt-submit-hook",
}

var (
	titleBlockRegexes = makeTitleBlockRegexes()
	titleStrayTag     = regexp.MustCompile(`</?(?:` + strings.Join(titleMarkupTags, "|") + `)>`)
	commandNameRegex  = regexp.MustCompile(`(?s)<command-name>(.*?)</command-name>`)
	titleNoisePrompt  = regexp.MustCompile(`^(?:\[Image[^\]]*\]\s*)+$|^\[Request interrupted by user[^\]]*\]$`)
)

func makeTitleBlockRegexes() []*regexp.Regexp {
	var rtn []*regexp.Regexp
	for _, tag := range titleMarkupTags {
		rtn = append(rtn, regexp.MustCompile(`(?s)<`+tag+`>.*?</`+tag+`>`))
	}
	return rtn
}

// cleanTitleText is the user's own text of a message: Claude Code's markup blocks removed, on one line.
func cleanTitleText(text string) string {
	for _, re := range titleBlockRegexes {
		text = re.ReplaceAllString(text, " ")
	}
	text = titleStrayTag.ReplaceAllString(text, " ")
	return oneLine(text)
}

// commandName is the slash command a record records ("/clear"), or "" when the record is not a command.
func commandName(text string) string {
	m := commandNameRegex.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	name := oneLine(m[1])
	if utf8.RuneCountInString(name) > maxCommandRunes {
		name = string([]rune(name)[:maxCommandRunes-1]) + "…"
	}
	return name
}

// isCommandRecord tells a record that only records a slash command (and its output) from a prompt of the user.
func isCommandRecord(text string) bool {
	return commandName(text) != "" || strings.Contains(text, "<local-command-stdout>") || strings.Contains(text, "<local-command-stderr>")
}

// titlePrompt is the text of a record fit to name a session: empty for commands, caveats, hook output, an
// interruption or an image alone.
func titlePrompt(text string) string {
	if isCommandRecord(text) {
		return ""
	}
	clean := cleanTitleText(text)
	if titleNoisePrompt.MatchString(clean) {
		return ""
	}
	return clean
}
