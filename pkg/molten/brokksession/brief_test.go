// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if got := readFile(t, filepath.Join(dir, "AGENTS.md")); got != brief {
		t.Errorf("AGENTS.md is %.40q, want the current brief in place of the one MoltenTerm wrote", got)
	}
	if got := readFile(t, filepath.Join(dir, "CLAUDE.md")); got != mine {
		t.Errorf("CLAUDE.md is %.40q, want the developer's file left as it was", got)
	}
}
