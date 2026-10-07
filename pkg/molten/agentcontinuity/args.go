// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

const (
	// Well under the smallest argv limit MoltenTerm runs on: a briefing goes through a file, not the prompt.
	maxInitialPromptBytes = 64 * 1024
	maxLabelRunes         = 80
)

// CleanLabel keeps a text read from an agent's file or output printable and short: no control character reaches a
// terminal or the interface.
func CleanLabel(label string) string {
	var sb strings.Builder
	count := 0
	for _, r := range strings.TrimSpace(label) {
		if unicode.IsControl(r) {
			continue
		}
		if count == maxLabelRunes {
			sb.WriteString("…")
			break
		}
		sb.WriteRune(r)
		count++
	}
	return sb.String()
}

// StripControl removes the control characters of a text printed to a terminal (a path, a probe's reason).
func StripControl(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

// A model id is a name, an alias with a variant (opus[1m]) or provider/model; never an option, a space or a control
// character, since it reaches the agent as one argument.
var modelIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$`)

// A session id is a UUID or a similar token.
var sessionIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// ValidModelId accepts the model ids an adapter passes to its agent.
func ValidModelId(model string) bool {
	return modelIdRegex.MatchString(model)
}

// ValidSessionId accepts the session ids an adapter passes to its agent.
func ValidSessionId(id string) bool {
	return sessionIdRegex.MatchString(id)
}

func checkModel(model string) error {
	if model == "" || ValidModelId(model) {
		return nil
	}
	return fmt.Errorf("invalid model id %q", model)
}

func checkSessionId(id string) error {
	if ValidSessionId(id) {
		return nil
	}
	return fmt.Errorf("invalid session id %q", id)
}

// promptArgs is the initial prompt as the last argument, always after "--", which both agents' parsers take as the
// end of the options and subcommands: a prompt that starts with a dash or is a subcommand's name (`logout`, `update`)
// stays a prompt.
func promptArgs(prompt string) ([]string, error) {
	if prompt == "" {
		return nil, nil
	}
	if len(prompt) > maxInitialPromptBytes {
		return nil, fmt.Errorf("the initial prompt is longer than %d bytes", maxInitialPromptBytes)
	}
	if strings.ContainsRune(prompt, 0) {
		return nil, fmt.Errorf("the initial prompt holds a NUL character")
	}
	return []string{"--", prompt}, nil
}

// singleWordPrompt tells whether a prompt is one word: Claude Code's parser takes such a prompt for a subcommand of
// that name even after "--" (`claude -- update` updates).
func singleWordPrompt(prompt string) bool {
	return len(strings.Fields(prompt)) == 1
}

// optionGrammar is what words parsing needs of an agent's options: those whose value is the next argument, and those
// that take every following argument up to the next option (clap's `<FILE>...`).
type optionGrammar struct {
	value  map[string]bool
	greedy map[string]bool
}

// words returns the arguments that are not options or option values, before "--".
func (g optionGrammar) words(args []string) []string {
	var rtn []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return rtn
		}
		if !strings.HasPrefix(arg, "-") {
			rtn = append(rtn, arg)
			continue
		}
		if g.greedy[arg] {
			for i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		if g.value[arg] {
			i++
		}
	}
	return rtn
}

// hasOption tells whether one of the options appears before "--", alone or as --name=value.
func hasOption(args []string, names ...string) bool {
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		for _, name := range names {
			if arg == name || strings.HasPrefix(arg, name+"=") {
				return true
			}
		}
	}
	return false
}
