// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentdocs

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"
)

const citationWindow = 160

var claudeMdRe = regexp.MustCompile(`(?i)claude\.md`)

// citesClaudeMdAlone reports the offsets where a text cites CLAUDE.md without AGENTS.md just before it: AGENTS.md is
// the instruction file standard, CLAUDE.md only Claude Code's fallback (#992).
func citesClaudeMdAlone(text string) []int {
	var rtn []int
	for _, loc := range claudeMdRe.FindAllStringIndex(text, -1) {
		start := loc[0] - citationWindow
		if start < 0 {
			start = 0
		}
		if !strings.Contains(strings.ToLower(text[start:loc[0]]), "agents.md") {
			rtn = append(rtn, loc[0])
		}
	}
	return rtn
}

func TestGuidesCiteAgentsMdFirst(t *testing.T) {
	err := fs.WalkDir(Files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(Files, path)
		if err != nil {
			return err
		}
		text := string(data)
		for _, off := range citesClaudeMdAlone(text) {
			line := strings.Count(text[:off], "\n") + 1
			t.Errorf("%s:%d cites CLAUDE.md without AGENTS.md first", path, line)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

func TestCitesClaudeMdAlone(t *testing.T) {
	if got := citesClaudeMdAlone("read `CLAUDE.md` or `AGENTS.md`"); len(got) != 1 {
		t.Fatalf("CLAUDE.md before AGENTS.md must be flagged, got %v", got)
	}
	if got := citesClaudeMdAlone("read `AGENTS.md` (`CLAUDE.md` as Claude Code's fallback)"); len(got) != 0 {
		t.Fatalf("AGENTS.md first must pass, got %v", got)
	}
}
