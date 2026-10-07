// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	// Well under the smallest argv limit MoltenTerm runs on: a briefing goes through a file, not the prompt.
	maxInitialPromptBytes = 64 * 1024
)

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

// promptArgs is the initial prompt as the last argument. One that starts with a dash would be read as an option, so
// it follows "--", which both agents' parsers take as the end of the options.
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
	if strings.HasPrefix(prompt, "-") {
		return []string{"--", prompt}, nil
	}
	return []string{prompt}, nil
}

// firstWord returns the first argument that is not an option, before "--", or "". valueOptions are the options
// whose value is the next argument.
func firstWord(args []string, valueOptions map[string]bool) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return ""
		}
		if strings.HasPrefix(arg, "-") {
			if valueOptions[arg] {
				i++
			}
			continue
		}
		return arg
	}
	return ""
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
