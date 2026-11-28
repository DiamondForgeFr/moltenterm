// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentdocs

import (
	"io/fs"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
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

// pages.md tells an agent to look at what is open before opening a page, and that an open page is reused (#2333).
func TestPagesGuideExplainsReusingAnOpenPage(t *testing.T) {
	data, err := fs.ReadFile(Files, "pages.md")
	if err != nil {
		t.Fatalf("pages.md is not embedded: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"`tabs_context`", "`otherPages`", "Reuse an open page", "reused tab N", "opened tab N", "like to use this page",
		"Allow and Open another tab", "waiting for the developer", "`newTab: true`", "`reload: true`", "molten open --new-tab",
		"hands nothing to you",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("pages.md does not mention %q", want)
		}
	}
}

// pages.md tells an agent without the MCP server to use `molten browser` (#2596): every command of the group, what it is
// the command of, the rules it keeps, and the tools that stay MCP-only.
func TestPagesGuideExplainsTheCommandLineForAgentsWithoutTheMcpServer(t *testing.T) {
	data, err := fs.ReadFile(Files, "pages.md")
	if err != nil {
		t.Fatalf("pages.md is not embedded: %v", err)
	}
	text := string(data)
	for _, b := range mcpbrowser.CliBindings() {
		switch {
		case b.Command == "":
			if !strings.Contains(text, "`"+b.Tool+"`") {
				t.Errorf("pages.md does not say that %s stays an MCP tool", b.Tool)
			}
		case strings.HasPrefix(b.Command, mcpbrowser.CliGroup+" "):
			if !strings.Contains(text, "molten "+b.Command) {
				t.Errorf("pages.md does not show `molten %s`", b.Command)
			}
			if !strings.Contains(text, "`"+b.Tool+"`") {
				t.Errorf("pages.md does not say which tool %s runs", b.Command)
			}
		}
	}
	for _, want := range []string{"Without an MCP server", "--json", "--new-tab", "--reload", "once the developer confirms", "untrusted-page-content",
		"asks the developer", "connections menu", "molten agent send", "exits 1"} {
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
