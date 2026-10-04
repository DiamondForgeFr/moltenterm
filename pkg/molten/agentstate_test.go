// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
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
		// Compound command lines (#141).
		"clear; claude":                  "claude",
		"cd app && codex --full-auto":    "codex",
		"make || gemini":                 "gemini",
		"(cd x && claude)":               "claude",
		"sleep 1 & claude":               "claude",
		"echo 'a; claude'":               "",
		"echo \"a && claude\"":           "",
		"echo a\\; claude":               "",
		"echo hi # ; claude":             "",
		"git log | less; vim claude.md":  "",
		"clear\nclaude":                  "claude",
		"FOO=1 clear && BAR=2 claude -c": "claude",
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

func TestFindAgentProcess(t *testing.T) {
	reads := map[int32]int{}
	exes := map[int32][]string{
		20: {"/Users/me/.local/share/claude/versions/2.1.283"},
		30: {"/usr/bin/node", "node", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"},
		40: {"/usr/bin/node", "node", "server.js"},
	}
	read := func(pid int32) (string, []string) {
		reads[pid]++
		args := exes[pid]
		return args[0], args
	}
	proc := func(pid int32, name string) *proctree.Proc {
		return &proctree.Proc{Pid: pid, Name: name, StartMs: int64(pid) * 1000}
	}
	cases := []struct {
		procs []*proctree.Proc
		agent string
		pid   int32
	}{
		{[]*proctree.Proc{proc(10, "zsh"), proc(11, "claude")}, "claude", 11},
		{[]*proctree.Proc{proc(40, "node"), proc(20, "2.1.283")}, "claude", 20},
		{[]*proctree.Proc{proc(30, "node"), proc(31, "codex")}, "codex", 30},
		{[]*proctree.Proc{proc(12, "opencode"), proc(13, "claude")}, "opencode", 12},
		{[]*proctree.Proc{proc(14, "sudo"), proc(15, "gemini")}, "gemini", 15},
		{[]*proctree.Proc{proc(40, "node"), proc(16, "vim"), proc(17, "claudette")}, "", 0},
	}
	for i, c := range cases {
		got, ok := FindAgentProcess(c.procs, read)
		if ok != (c.agent != "") || got.Agent != c.agent || got.Pid != c.pid {
			t.Errorf("case %d: %+v %v", i, got, ok)
		}
	}
	if reads[40] != 1 || reads[20] != 1 || reads[30] != 1 {
		t.Errorf("each candidate is read once: %v", reads)
	}
	if _, ok := FindAgentProcess([]*proctree.Proc{proc(16, "vim")}, read); ok || reads[16] != 0 {
		t.Error("a plain process is never read")
	}
}
