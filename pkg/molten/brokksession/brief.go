// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

// BriefMarker starts every brief MoltenTerm writes: a file in his folder that does not start with it is the
// developer's, and is never touched (FR-BOSS-004, AC12, #2033).
const BriefMarker = "<!-- molten:brokk-brief"

// The agents of the catalog read their instructions from the folder they work in: Claude Code from CLAUDE.md, the
// others from AGENTS.md.
var briefFiles = []string{"AGENTS.md", "CLAUDE.md"}

//go:embed brief.md
var brief string

// The brainstorm section (FR-BOSS-010, DS-BOSS-009, #2246): how he writes the graph of his thought. Only a build whose
// channel allows brainstorms teaches it, so a release never asks him for a block nothing would read.
//
//go:embed brief-brainstorm.md
var briefBrainstorm string

// BriefText is his brief, with the brainstorm section when brainstorm is true.
func BriefText(brainstorm bool) string {
	if !brainstorm {
		return brief
	}
	return brief + briefBrainstorm
}

// WriteBrief puts his brief in his folder: a file that is missing is written, one MoltenTerm wrote is refreshed when
// the brief changed, one it did not write stays as it is. The brainstorm section follows the build channel.
func WriteBrief(dir string) error {
	return writeBrief(dir, BriefText(buildchannel.BrainstormEnabled()))
}

func writeBrief(dir string, text string) error {
	var failed []string
	for _, name := range briefFiles {
		if err := writeBriefFile(filepath.Join(dir, name), text); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%s", strings.Join(failed, "; "))
	}
	return nil
}

func writeBriefFile(path string, text string) error {
	existing, err := os.ReadFile(path)
	if err == nil {
		if !strings.HasPrefix(string(existing), BriefMarker) || string(existing) == text {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte(text), 0o600)
}
