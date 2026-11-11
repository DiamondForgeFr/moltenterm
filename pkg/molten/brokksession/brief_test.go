// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

// FR-BOSS-004, AC12 (#2033): his folder holds the brief that tells him how to offer replies.
func TestWriteBriefPutsTheReplyConventionInHisFolder(t *testing.T) {
	dir := t.TempDir()
	if err := WriteBrief(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readFile(t, filepath.Join(dir, name))
		if !strings.HasPrefix(text, BriefMarker) {
			t.Errorf("%s does not start with the marker: %.40q", name, text)
		}
		if !strings.Contains(text, "```brokk-actions") || !strings.Contains(text, "authorise") {
			t.Errorf("%s does not teach the reply block and the authorisation flag", name)
		}
	}
}

// FR-BOSS-010 AC1 and AC21 (#2246): a gold, dev or local build teaches him the graph block; a release never does.
func TestTheBrainstormSectionFollowsTheGate(t *testing.T) {
	t.Parallel()
	with := BriefText(true)
	without := BriefText(false)
	if !strings.HasPrefix(with, without) {
		t.Fatal("the brainstorm section is not added after the brief")
	}
	for _, want := range []string{"```brokk-graph", `"op": "centre"`, `"op": "add"`, "`link`", "`talk`", "Brainstorm:"} {
		if !strings.Contains(with, want) {
			t.Errorf("the brainstorm section does not teach %q", want)
		}
	}
	if strings.Contains(without, "brokk-graph") || strings.Contains(without, "Brainstorm") {
		t.Error("the brief of a release mentions brainstorms")
	}
	dir := t.TempDir()
	if err := writeBrief(dir, with); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "AGENTS.md")); got != with {
		t.Errorf("AGENTS.md is %.40q, want the brief with its brainstorm section", got)
	}
	// The same folder after a change of channel: the section goes with the refresh.
	if err := writeBrief(dir, without); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "CLAUDE.md")); got != without {
		t.Errorf("CLAUDE.md still holds the brainstorm section on a release")
	}
}

// The brief follows the gate: a public build launched as a gold still gets the release's brief.
func TestTheBriefOfAReleaseHasNoBrainstormSection(t *testing.T) {
	t.Parallel()
	release := BriefText(buildchannel.BrainstormAllowed(buildchannel.GateChannel(false, buildchannel.Public, buildchannel.Gold)))
	if strings.Contains(release, "brokk-graph") {
		t.Error("a public release's brief teaches the graph block")
	}
	gold := BriefText(buildchannel.BrainstormAllowed(buildchannel.GateChannel(false, buildchannel.Gold, "")))
	if !strings.Contains(gold, "brokk-graph") {
		t.Error("a gold's brief does not teach the graph block")
	}
}

func TestWriteBriefRefreshesWhatItWroteAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	older := BriefMarker + " v0 -->\nan older brief\n"
	mine := "# My own instructions for Brokk\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(older), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(mine), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteBrief(dir); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "AGENTS.md")); got != BriefText(buildchannel.BrainstormEnabled()) {
		t.Errorf("AGENTS.md is %.40q, want the current brief in place of the one MoltenTerm wrote", got)
	}
	if got := readFile(t, filepath.Join(dir, "CLAUDE.md")); got != mine {
		t.Errorf("CLAUDE.md is %.40q, want the developer's file left as it was", got)
	}
}
