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
