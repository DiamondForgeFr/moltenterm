// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// BriefMarker starts every brief MoltenTerm writes: a file in his folder that does not start with it is the
// developer's, and is never touched (FR-BOSS-004, AC12, #2033).
const BriefMarker = "<!-- molten:brokk-brief"

// The agents of the catalog read their instructions from the folder they work in: Claude Code from CLAUDE.md, the
// others from AGENTS.md.
var briefFiles = []string{"AGENTS.md", "CLAUDE.md"}

//go:embed brief.md
var brief string

// WriteBrief puts his brief in his folder: a file that is missing is written, one MoltenTerm wrote is refreshed when
// the brief changed, one it did not write stays as it is.
func WriteBrief(dir string) error {
	var failed []string
	for _, name := range briefFiles {
		if err := writeBriefFile(filepath.Join(dir, name)); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%s", strings.Join(failed, "; "))
	}
	return nil
}

func writeBriefFile(path string) error {
	existing, err := os.ReadFile(path)
	if err == nil {
		if !strings.HasPrefix(string(existing), BriefMarker) || string(existing) == brief {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte(brief), 0o600)
}
