// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

func TestMatchAgentCommand(t *testing.T) {
	cases := map[string]string{
		"claude":                              "claude",
		"claude --resume":                     "claude",
		"  /Users/me/.local/bin/claude -p hi": "claude",
		"FOO=1 BAR='a b' claude":              "claude",
		"env DEBUG=1 codex":                   "codex",
		"npx -y @openai/codex":                "codex",
		"npx @anthropic-ai/claude-code":       "claude",
		"gemini":                              "gemini",
		"time opencode run x":                 "opencode",
		"vim claude.md":                       "",
		"git commit -m claude":                "",
		"claudette":                           "",
		"# command too large (9000 bytes)":    "",
		"":                                    "",
		"cat file | claude":                   "",
		"\"claude\"":                          "claude",
		"exec codex":                          "codex",
		"./node_modules/.bin/opencode --help": "opencode",
	}
	for cmd, want := range cases {
		if got := MatchAgentCommand(cmd); got != want {
			t.Errorf("MatchAgentCommand(%q) = %q, want %q", cmd, got, want)
		}
	}
}

func TestAgentStateUrgency(t *testing.T) {
	order := []string{AgentStateWaiting, AgentStateError, AgentStateWorking, AgentStateDone, AgentStateIdle}
	for i := 1; i < len(order); i++ {
		if AgentStateUrgency(order[i-1]) <= AgentStateUrgency(order[i]) {
			t.Errorf("%s should be more urgent than %s", order[i-1], order[i])
		}
	}
}

func TestAttentionAgentState(t *testing.T) {
	cases := []struct{ title, message, want string }{
		{"A terminal needs your attention", "Bell", AgentStateWaiting},
		{"Claude needs your permission to use Bash", "", AgentStateWaiting},
		{"Claude is waiting for your input", "", AgentStateWaiting},
		{"Codex", "Turn complete", AgentStateDone},
		{"Task finished", "", AgentStateDone},
	}
	for _, c := range cases {
		if got := AttentionAgentState(c.title, c.message); got != c.want {
			t.Errorf("AttentionAgentState(%q, %q) = %q, want %q", c.title, c.message, got, c.want)
		}
	}
}

func TestValidAgentIdAndState(t *testing.T) {
	for _, id := range []string{"claude", "aider", "my-agent2"} {
		if !ValidAgentId(id) {
			t.Errorf("%q should be valid", id)
		}
	}
	for _, id := range []string{"", "Claude", "a b", "-x", "../x", strings.Repeat("a", 40)} {
		if ValidAgentId(id) {
			t.Errorf("%q should be invalid", id)
		}
	}
	if ValidAgentState("busy") || !ValidAgentState(AgentStateDone) {
		t.Errorf("state validation is wrong")
	}
}

func TestCleanAgentMessage(t *testing.T) {
	if got := CleanAgentMessage("Claude needs\x1b[31m your\n permission\x07"); got != "Claude needs [31m your permission" {
		t.Errorf("got %q", got)
	}
	long := CleanAgentMessage(strings.Repeat("é", 500))
	if len([]rune(long)) != AgentMessageMaxLength {
		t.Errorf("long message has %d runes", len([]rune(long)))
	}
}

func TestAgentProcessCommand(t *testing.T) {
	reads := 0
	read := func(exe string, args ...string) func() (string, []string) {
		return func() (string, []string) {
			reads++
			return exe, args
		}
	}
	got := AgentProcessCommand("10/1", "2.1.283", read("/Users/me/.local/share/claude/versions/2.1.283"))
	if got != "Claude Code (2.1.283)" {
		t.Errorf("claude: %q", got)
	}
	AgentProcessCommand("10/1", "2.1.283", read("/x"))
	if reads != 1 {
		t.Errorf("the second call should come from the cache, reads=%d", reads)
	}
	if got := AgentProcessCommand("11/1", "node", read("/usr/bin/node", "node", "/usr/local/bin/gemini")); got != "Gemini CLI (node)" {
		t.Errorf("gemini: %q", got)
	}
	if got := AgentProcessCommand("12/1", "node", read("/usr/bin/node", "node", "server.js")); got != "node" {
		t.Errorf("plain node: %q", got)
	}
	if got := AgentProcessCommand("13/1", "zsh", read("/bin/zsh")); got != "zsh" || reads != 3 {
		t.Errorf("a non-candidate is never read: %q reads=%d", got, reads)
	}
}
