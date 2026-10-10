// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"strings"
	"testing"
)

func TestAgentCommandTables(t *testing.T) {
	for _, agent := range []string{"claude", "codex"} {
		adapter := Find(agent)
		seen := map[string]bool{}
		for _, c := range AgentCommands(agent) {
			if seen[c.Action] {
				t.Errorf("%s: %s twice", agent, c.Action)
			}
			seen[c.Action] = true
			if c.Kind == CommandSlash && (!strings.HasPrefix(c.Text, "/") || strings.ContainsAny(c.Text, " \r\n\x1b")) {
				t.Errorf("%s: %s is not one slash command: %q", agent, c.Action, c.Text)
			}
		}
		quit, ok := FindAgentCommand(agent, ActionQuit)
		if !ok || quit.Text != adapter.Exit().Command {
			t.Errorf("%s: quit %q, exit %q", agent, quit.Text, adapter.Exit().Command)
		}
		if interrupt, ok := FindAgentCommand(agent, ActionInterrupt); !ok || interrupt.Kind != CommandInterrupt || interrupt.ClearsLine() {
			t.Errorf("%s: interrupt %+v", agent, interrupt)
		}
	}
	if _, ok := FindAgentCommand("claude", ActionDiff); ok {
		t.Errorf("diff is a Codex command")
	}
	if AgentCommands("gemini") != nil {
		t.Errorf("an agent without a table has no commands")
	}
}
