// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"
)

// pages.md is what the instructions of the molten-browser server point to for a page shown to the developer (#1812).
func TestPagesGuideSendsPagesToMoltenTermsBrowser(t *testing.T) {
	data, err := fs.ReadFile(Files, "pages.md")
	if err != nil {
		t.Fatalf("pages.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{"tabs_create", "navigate", "molten open", "--browser installed", "xdg-open", "BROWSER", "keyboard focus", "360"} {
		if !strings.Contains(text, want) {
			t.Errorf("pages.md does not mention %q", want)
		}
	}
}

// pages.md tells an agent that a local or inline page waits for the developer's answer (#1978).
func TestPagesGuideSaysLocalPagesAsk(t *testing.T) {
	data, err := fs.ReadFile(Files, "pages.md")
	if err != nil {
		t.Fatalf("pages.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{"`file:` or `data:` page", "confirms it in the", "http://localhost", "if they decline"} {
		if !strings.Contains(text, want) {
			t.Errorf("pages.md does not mention %q", want)
		}
	}
}

// pages.md tells an agent how to bring a page it already has back in front of the developer (#1994).
func TestPagesGuideExplainsShowingAPageAgain(t *testing.T) {
	data, err := fs.ReadFile(Files, "pages.md")
	if err != nil {
		t.Fatalf("pages.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{"`tabs_show`", "grid view", "magnif", "is showing you this page", "never moves"} {
		if !strings.Contains(text, want) {
			t.Errorf("pages.md does not mention %q", want)
		}
	}
}
