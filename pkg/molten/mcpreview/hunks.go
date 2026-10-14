// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpreview

import (
	"regexp"
	"strconv"
	"strings"
)

// Hunks of a file's diff, shared by the Review tab's comments (pkg/molten/review) and the review session's comment
// proposals (pkg/molten/reviewsession): GitHub takes a line comment only inside one hunk of its side.

// HunkContext: GitHub's diff shows three lines of context around each change.
const HunkContext = 3

var hunkHeaderRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// Hunk is one hunk of a file's diff, by its line ranges on the base (old) and head (new) sides.
type Hunk struct {
	OldStart int `json:"oldstart"`
	OldLines int `json:"oldlines"`
	NewStart int `json:"newstart"`
	NewLines int `json:"newlines"`
}

// ParseHunks reads the hunk headers of a unified diff.
func ParseHunks(out []byte) []Hunk {
	var rtn []Hunk
	for _, line := range strings.Split(string(out), "\n") {
		m := hunkHeaderRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		h := Hunk{OldLines: 1, NewLines: 1}
		h.OldStart, _ = strconv.Atoi(m[1])
		if m[2] != "" {
			h.OldLines, _ = strconv.Atoi(m[2])
		}
		h.NewStart, _ = strconv.Atoi(m[3])
		if m[4] != "" {
			h.NewLines, _ = strconv.Atoi(m[4])
		}
		rtn = append(rtn, h)
	}
	return rtn
}

// InHunk tells whether lines start to end of a side lie in one hunk: GitHub refuses a line comment elsewhere, and a
// multi-line comment across two hunks.
func InHunk(hunks []Hunk, side string, start int, end int) bool {
	if start <= 0 {
		start = end
	}
	for _, h := range hunks {
		first, count := h.NewStart, h.NewLines
		if side == SideLeft {
			first, count = h.OldStart, h.OldLines
		}
		if count > 0 && start >= first && end <= first+count-1 {
			return true
		}
	}
	return false
}
