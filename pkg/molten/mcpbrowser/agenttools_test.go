// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
