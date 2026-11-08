// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mcpbrowser

import (
	"strings"
	"testing"
)

type namedBackend struct {
	fakeBackend
	name string
}

func (b *namedBackend) Instructions(base string) string {
	return ServerInstructions + AgentInstructions(b.name)
}

func TestInitializeTellsTheAgentItsFirstName(t *testing.T) {
	c := startServer(t, &namedBackend{name: "Jérôme"})
	defer c.close()
	c.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code"}}}`)
	instructions := c.recv()["result"].(map[string]any)["instructions"].(string)
	if !strings.HasPrefix(instructions, "MoltenTerm browser:") || !strings.Contains(instructions, "your first name is Jérôme") ||
		!strings.Contains(instructions, "list_agents") || !strings.Contains(instructions, "molten agent whoami --trailer") {
		t.Fatalf("instructions = %q", instructions)
	}
	plain := startServer(t, &fakeBackend{})
	defer plain.close()
	plain.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	instructions = plain.recv()["result"].(map[string]any)["instructions"].(string)
	if strings.Contains(instructions, "first name is") || strings.Contains(instructions, "whoami") || !strings.Contains(instructions, "send_to_agent") {
		t.Fatalf("instructions without a name = %q", instructions)
	}
}

// Claude Code and Codex both get these instructions from the molten browser server (FR-FILE-002 AC-10).
func TestAgentInstructionsMentionMoltenFiles(t *testing.T) {
	for _, name := range []string{"", "Olivia"} {
		got := AgentInstructions(name)
		if !strings.Contains(got, "molten files") || !strings.Contains(got, "files.md") {
			t.Fatalf("instructions for %q do not mention molten files: %s", name, got)
		}
	}
}

// A lead of any CLI learns to settle the stop of an agent whose question it decided (#1876).
func TestAgentInstructionsMentionSettlingAStop(t *testing.T) {
	for _, name := range []string{"", "Arthur"} {
		got := AgentInstructions(name)
		if !strings.Contains(got, "molten agent decision settle") || !strings.Contains(got, "agent-decisions.md") {
			t.Fatalf("instructions for %q do not mention settling a stop: %s", name, got)
		}
	}
}

// Claude Code and Codex start the same server and read the instructions it returns at initialize: a page shown to the
// developer opens in MoltenTerm's browser for both, with or without the agent's first name (#1812).
func TestInitializeTellsEveryAgentToShowPagesInMoltenTerm(t *testing.T) {
	var seen []string
	for _, client := range []string{"claude-code", "codex-mcp-client"} {
		for _, backend := range []Backend{&fakeBackend{}, &namedBackend{name: "Olivia"}} {
			c := startServer(t, backend)
			c.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"` + client + `"}}}`)
			instructions := c.recv()["result"].(map[string]any)["instructions"].(string)
			c.close()
			for _, want := range []string{"tabs_create", "navigate", "tabs_show", "molten open", "pages.md", "xdg-open", "system browser", "keyboard focus"} {
				if !strings.Contains(instructions, want) {
					t.Fatalf("instructions for %s (%T) lack %q: %s", client, backend, want, instructions)
				}
			}
			seen = append(seen, instructions)
		}
	}
	if seen[0] != seen[2] || seen[1] != seen[3] {
		t.Fatal("Claude Code and Codex must read the same instructions")
	}
}

// Claude Code and Codex both learn of the project's bookmarks from the molten browser server (FR-BRW-020).
func TestAgentInstructionsMentionMoltenBookmarks(t *testing.T) {
	for _, name := range []string{"", "Olivia"} {
		got := AgentInstructions(name)
		if !strings.Contains(got, "molten bookmarks list") || !strings.Contains(got, "bookmarks.md") {
			t.Fatalf("instructions for %q do not mention molten bookmarks: %s", name, got)
		}
	}
}

// Claude Code and Codex both learn of `molten learn` from the molten browser server (FR-LRN-002).
func TestAgentInstructionsMentionMoltenLearn(t *testing.T) {
	for _, name := range []string{"", "Olivia"} {
		got := AgentInstructions(name)
		for _, want := range []string{"molten learn defaults", "molten learn record", "learning.md"} {
			if !strings.Contains(got, want) {
				t.Fatalf("instructions for %q do not mention %q: %s", name, want, got)
			}
		}
	}
}

func TestAgentToolsStayOutOfBrowserBatches(t *testing.T) {
	if ToolNames()[ToolSendToAgent] || ToolNames()[ToolListAgents] {
		t.Fatal("browser_batch must not run the handoff tools")
	}
	if !IsAgentTool(ToolSendToAgent) || IsAgentTool(ToolNavigate) {
		t.Fatal("IsAgentTool")
	}
	if !BrowserSpec().hasTool(ToolSendToAgent) {
		t.Fatal("the browser server serves the handoff tools")
	}
}

func TestFormatAgentList(t *testing.T) {
	you := AgentListEntry{FirstName: "Camille", AgentName: "Claude Code", You: true}
	text := FormatAgentList(AgentList{You: &you, Agents: []AgentListEntry{you,
		{FirstName: "Jérôme", AgentName: "Codex", Project: "projectb", Workspace: "B", Tab: "T2", State: "idle"}}})
	want := "You are Camille (Claude Code).\nAgents you can hand work to (send_to_agent with the first name):\n" +
		"- Jérôme: Codex, project projectb, workspace \"B\", tab \"T2\", idle"
	if text != want {
		t.Fatalf("%q", text)
	}
	if got := FormatAgentList(AgentList{You: &you, Agents: []AgentListEntry{you}}); !strings.HasSuffix(got, "No other agent is running in MoltenTerm.") {
		t.Fatalf("%q", got)
	}
}
