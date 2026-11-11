// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

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
	return BriefTextWith(brainstorm, nil)
}

// A saved title longer than this is cut in his list.
const maxBriefTitleLen = 160

// BriefTextWith is his brief with the brainstorm section, and in it the saved brainstorms' titles (FR-BOSS-010 AC10b,
// #2248): the titles alone, never what a folder holds, so that he can offer to resume one. A release has neither.
func BriefTextWith(brainstorm bool, titles []string) string {
	if !brainstorm {
		return brief
	}
	text := brief + briefBrainstorm
	var lines []string
	for _, title := range titles {
		clean := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
			if r < 0x20 || r == 0x7f || r == '`' {
				return ' '
			}
			return r
		}, title)), " ")
		if runes := []rune(clean); len(runes) > maxBriefTitleLen {
			clean = string(runes[:maxBriefTitleLen])
		}
		if clean != "" {
			lines = append(lines, "- "+clean)
		}
	}
	if len(lines) == 0 {
		return text + "\nThe developer has no saved brainstorm yet.\n"
	}
	return text + "\nThe developer's saved brainstorms, the one changed last first (their titles only: MoltenTerm keeps them):\n\n" +
		strings.Join(lines, "\n") + "\n"
}

// savedTitles gives the saved brainstorms' titles; wavesrv sets it at Start (brainstorm.LiveTitles), and until then, as
// in tests, his brief lists none.
var savedTitles atomic.Pointer[func() []string]

func liveBriefText() string {
	var titles []string
	if source := savedTitles.Load(); source != nil {
		titles = (*source)()
	}
	return BriefTextWith(buildchannel.BrainstormEnabled(), titles)
}

// WriteBrief puts his brief in his folder: a file that is missing is written, one MoltenTerm wrote is refreshed when
// the brief changed, one it did not write stays as it is. The brainstorm section follows the build channel.
func WriteBrief(dir string) error {
	return writeBrief(dir, liveBriefText())
}

// CurrentBrief writes his brief (WriteBrief) and returns its version and its text, for a session that runs: an agent
// reads its instructions file once, when it starts, so a running one gets a newer brief with the next message (#2257).
// The version is "" when every brief file of his folder is the developer's: theirs is followed, never replaced.
func CurrentBrief(dir string) (string, string, error) {
	return currentBrief(dir, liveBriefText())
}

func currentBrief(dir string, text string) (string, string, error) {
	err := writeBrief(dir, text)
	for _, name := range briefFiles {
		existing, readErr := os.ReadFile(filepath.Join(dir, name))
		if readErr == nil && string(existing) == text {
			return BriefVersion(text), text, err
		}
	}
	return "", "", err
}

// BriefVersion names a brief's text: two texts have the same version only when they are the same.
func BriefVersion(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
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
