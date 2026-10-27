// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"strings"
	"testing"
)

func TestCommandNames(t *testing.T) {
	cases := map[string]string{
		"gh pr view 12 --json title":                       "gh",
		"cd /tmp && go test ./... | tail -5":               "go,tail",
		"FOO=1 BAR=x /usr/local/bin/task build; echo done": "task",
		"sudo -n npx vitest run && npx eslint .":           "npx",
		"export X=1\nffmpeg -i in.mov out.gif":             "ffmpeg",
		"$EDITOR file || (git status)":                     "git",
		"for f in *.go; do gofmt -l $f; done":              "gofmt",
		"VERY_LONG=1":                                      "",
		"./scripts/moltenterm-check-ledger.mjs --verbose":  "moltenterm-check-ledger.mjs",
		"node scripts/x.mjs > out.txt 2>&1 && cat out.txt": "node,cat",
		"  ": "",
		"time env GOFLAGS=-mod=mod go vet ./pkg/... ; git diff": "go,git",
	}
	for line, want := range cases {
		if got := strings.Join(commandNames(line), ","); got != want {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestNoteShellCommandKeepsFirstUseOrderAndCap(t *testing.T) {
	s := MakeSession()
	s.NoteShellCommand("git status && gh pr list")
	s.NoteShellCommand("go test ./... && git diff")
	if got := strings.Join(s.Commands(), ","); got != "git,gh,go" {
		t.Fatalf("commands: %s", got)
	}
	for i := 0; i < maxCommands*2; i++ {
		s.NoteShellCommand("tool" + strings.Repeat("x", i%30) + string(rune('a'+i%26)))
	}
	if len(s.Commands()) != maxCommands {
		t.Fatalf("cap: %d", len(s.Commands()))
	}
}

// Claude Code's Bash and Codex's shell calls feed the same list (FR-SHELL-084: Claude Code and Codex alike).
func TestAdaptersNoteShellCommands(t *testing.T) {
	claude := MakeSession()
	parseFile(t, MakeClaudeAdapter([]string{"/nowhere"}), claude, "claude-session.jsonl")
	if got := strings.Join(claude.Commands(), ","); got != "rm" {
		t.Errorf("claude: %q", got)
	}
	codex := MakeSession()
	parseFile(t, MakeCodexAdapter([]string{"/nowhere"}), codex, "codex-session.jsonl")
	if got := codex.Commands(); len(got) == 0 || got[0] != "sed" {
		t.Errorf("codex: %q", got)
	}
}

func TestShellLineReadsStringsAndArgv(t *testing.T) {
	if got := shellLine(map[string]any{"command": "gh pr view"}); got != "gh pr view" {
		t.Fatalf("string: %q", got)
	}
	if got := shellLine(map[string]any{"command": []any{"bash", "-lc", "go test ./..."}}); got != "go test ./..." {
		t.Fatalf("argv: %q", got)
	}
	if got := shellLine(map[string]any{"cmd": "rg foo"}); got != "rg foo" {
		t.Fatalf("cmd: %q", got)
	}
}
