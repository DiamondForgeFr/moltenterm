// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	BumpMajor = "major"
	BumpMinor = "minor"
	BumpPatch = "patch"

	UnconventionalCount = "(unconventional)"
)

// Types whose presence alone is not a reason to release anything.
var silentTypes = map[string]bool{
	"chore": true, "ci": true, "test": true, "style": true, "docs": true, "build": true, "refactor": true,
}

var subjectRegex = regexp.MustCompile(`^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$`)
var breakingBodyRegex = regexp.MustCompile(`(?m)^BREAKING[ -]CHANGE:`)

type CommitInput struct {
	Subject string `json:"subject"`
	Body    string `json:"body,omitempty"`
}

type ParsedCommit struct {
	Type     string
	Breaking bool
	Subject  string
}

// ParseCommit reads a conventional subject (`type(#N)!: subject`); false for a subject outside the convention, which
// is counted, never guessed at.
func ParseCommit(c CommitInput) (ParsedCommit, bool) {
	m := subjectRegex.FindStringSubmatch(strings.TrimSpace(c.Subject))
	if m == nil {
		return ParsedCommit{}, false
	}
	return ParsedCommit{Type: m[1], Breaking: m[3] == "!" || breakingBodyRegex.MatchString(c.Body), Subject: m[4]}, true
}

type BumpDecision struct {
	Level    string         `json:"level"`
	Version  string         `json:"version"`
	Counts   map[string]int `json:"counts"`
	Breaking []string       `json:"breaking"`
	Reason   string         `json:"reason"`
}

func ApplyBump(v Version, level string) Version {
	switch level {
	case BumpMajor:
		return Version{Major: v.Major + 1}
	case BumpMinor:
		return Version{Major: v.Major, Minor: v.Minor + 1}
	}
	return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch + 1}
}

// DecideBump reads the next public version from the commits since the last one: a breaking change is a major bump, a
// feat a minor one, anything else a user sees a patch. nil when the commits do not justify a release: a version made
// of chore and ci commits would be offered for nothing.
func DecideBump(last Version, commits []CommitInput) *BumpDecision {
	counts := map[string]int{}
	breaking := []string{}
	hasFeat, hasUserFacing := false, false
	unconventional := 0
	for _, c := range commits {
		parsed, ok := ParseCommit(c)
		if !ok {
			unconventional++
			continue
		}
		counts[parsed.Type]++
		if parsed.Breaking {
			breaking = append(breaking, parsed.Subject)
		}
		hasFeat = hasFeat || parsed.Type == "feat"
		hasUserFacing = hasUserFacing || !silentTypes[parsed.Type]
	}
	if unconventional > 0 {
		counts[UnconventionalCount] = unconventional
	}
	if !hasUserFacing && len(breaking) == 0 {
		return nil
	}
	level, reason := BumpPatch, fmt.Sprintf("%d fix(es), no new feature", counts["fix"])
	if hasFeat {
		level, reason = BumpMinor, fmt.Sprintf("%d new feature(s)", counts["feat"])
	}
	if len(breaking) > 0 {
		level, reason = BumpMajor, fmt.Sprintf("%d breaking change(s)", len(breaking))
	}
	return &BumpDecision{
		Level:    level,
		Version:  ApplyBump(last.Base(), level).String(),
		Counts:   counts,
		Breaking: breaking,
		Reason:   reason,
	}
}
