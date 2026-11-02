// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"path/filepath"
	"testing"
)

func TestIntegrationInArgs(t *testing.T) {
	dir := filepath.Join("/data", "molten", "agent-launch")
	mcp := filepath.Join(dir, "claude-mcp-0123.json")
	settings := filepath.Join(dir, "claude-4567.json")
	cases := []struct {
		name  string
		agent string
		args  []string
		want  ArgsIntegration
	}{
		{"claude with browser and settings", ClaudeAgentId, []string{"/usr/bin/node", "/opt/claude", "--mcp-config=" + mcp, "--settings", settings}, ArgsIntegration{Integrated: true, Browser: true}},
		{"claude settings only", ClaudeAgentId, []string{"claude", "--settings", settings}, ArgsIntegration{Integrated: true}},
		{"claude user's own mcp config", ClaudeAgentId, []string{"claude", "--mcp-config", "/home/me/mcp.json", "--settings", "/home/me/s.json"}, ArgsIntegration{}},
		{"claude mcp file elsewhere", ClaudeAgentId, []string{"claude", "--mcp-config=/tmp/claude-mcp-1.json"}, ArgsIntegration{}},
		{"claude bare", ClaudeAgentId, []string{"claude"}, ArgsIntegration{}},
		{"codex with browser and notify", CodexAgentId, []string{"codex", "-c", `notify=["/bin/molten","agent","notify","--agent","codex","--"]`, "-c", `mcp_servers.molten-browser.command="/bin/molten"`}, ArgsIntegration{Integrated: true, Browser: true}},
		{"codex notify only", CodexAgentId, []string{"codex", "--config", `notify=["/bin/molten","agent","notify","--agent","codex","--"]`}, ArgsIntegration{Integrated: true}},
		{"codex user's own notify", CodexAgentId, []string{"codex", "-c", `notify=["/bin/say"]`}, ArgsIntegration{}},
		{"other agent", "gemini", []string{"gemini", "--mcp-config=" + mcp}, ArgsIntegration{}},
	}
	for _, c := range cases {
		if got := IntegrationInArgs(c.agent, c.args); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}
