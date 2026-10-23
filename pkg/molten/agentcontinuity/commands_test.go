// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"os"
	"path/filepath"
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

// readCodexSlashCommands reads the slash commands of the Codex version the table was read on (#990).
func readCodexSlashCommands(t *testing.T) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "codex-0.163.0-slash-commands.txt"))
	if err != nil {
		t.Fatalf("read the slash command list: %v", err)
	}
	rtn := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		rtn[line] = true
	}
	return rtn
}

// TC-SHELL-048-3: every Codex slash command of the table exists in codex-cli 0.163.0, and /approvals is gone.
func TestCodexCommandsAgainstSlashList(t *testing.T) {
	known := readCodexSlashCommands(t)
	if known["/approvals"] {
		t.Fatalf("the 0.163.0 list has no /approvals")
	}
	for _, c := range codexCommands {
		if c.Kind != CommandSlash {
			continue
		}
		if !known[c.Text] {
			t.Errorf("%s: %s is not a codex-cli 0.163.0 slash command", c.Action, c.Text)
		}
	}
	want := map[string]string{
		ActionPermissions: "/permissions", ActionNew: "/new", ActionClear: "/clear", ActionCompact: "/compact",
		ActionModel: "/model", ActionResume: "/resume", ActionFork: "/fork", ActionRename: "/rename", ActionCopy: "/copy",
		ActionStatus: "/status", ActionReview: "/review", ActionDiff: "/diff", ActionQuit: "/exit",
	}
	for action, text := range want {
		if c, ok := FindAgentCommand("codex", action); !ok || c.Text != text {
			t.Errorf("codex %s: got %+v, want %s", action, c, text)
		}
	}
}
