// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeWorkFolderLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func codexExecLine(workdir string) string {
	args, _ := json.Marshal(map[string]any{"cmd": "git status", "workdir": workdir})
	return fmt.Sprintf(`{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":%q,"call_id":"c"}}`, string(args))
}

func codexExecBeginLine(cwd string) string {
	return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"exec_command_begin","call_id":"c","cwd":%q}}`, cwd)
}

// #1476: a Codex main session works where its newest shell command runs when that is in a repository, else in its
// turn's folder; a Claude Code session where its latest record's cwd is.
func TestAdaptersReadWhereASessionWorks(t *testing.T) {
	base := t.TempDir()
	main := filepath.Join(base, "p")
	tree := filepath.Join(base, "trees", "mt-7")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{filepath.Join(main, ".git"), filepath.Join(main, "src"), tree, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(tree, ".git"), []byte("gitdir: "+filepath.Join(main, ".git", "worktrees", "mt-7")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":"s1","cwd":%q,"source":"cli"}}`, main)
	turn := fmt.Sprintf(`{"type":"turn_context","payload":{"cwd":%q,"model":"gpt-5.5"}}`, main)
	codex := MakeCodexAdapter([]string{base})
	for _, c := range []struct {
		name  string
		lines []string
		want  string
	}{
		{"no command", []string{meta, turn}, main},
		{"workdir in a worktree", []string{meta, turn, codexExecLine(main), codexExecLine(tree)}, tree},
		{"exec event in a worktree", []string{meta, turn, codexExecBeginLine(tree)}, tree},
		{"back in its checkout", []string{meta, turn, codexExecLine(tree), codexExecBeginLine(main)}, main},
		{"relative workdir", []string{meta, turn, codexExecLine("src")}, filepath.Join(main, "src")},
		{"outside any repository", []string{meta, turn, codexExecLine(tree), codexExecLine(outside)}, main},
		{"header only", []string{meta}, main},
	} {
		path := filepath.Join(base, "codex", strings.ReplaceAll(c.name, " ", "-")+".jsonl")
		writeWorkFolderLines(t, path, c.lines...)
		if got, ok := codex.WorkFolder(path); !ok || got != c.want {
			t.Errorf("codex, %s: %q %v, want %q", c.name, got, ok, c.want)
		}
	}
	if got, ok := codex.WorkFolder(filepath.Join(base, "missing.jsonl")); ok || got != "" {
		t.Errorf("codex, no rollout: %q %v", got, ok)
	}

	claude := MakeClaudeAdapter([]string{base})
	rec := func(cwd string) string {
		data, _ := json.Marshal(map[string]any{"type": "user", "cwd": cwd})
		return string(data)
	}
	path := filepath.Join(base, "claude", "s.jsonl")
	writeWorkFolderLines(t, path, rec(main), rec(tree), `{"type":"summary"}`)
	if got, ok := claude.WorkFolder(path); !ok || got != tree {
		t.Errorf("claude, moved to a worktree: %q %v", got, ok)
	}
	writeWorkFolderLines(t, path, `{"type":"summary"}`)
	if got, ok := claude.WorkFolder(path); ok || got != "" {
		t.Errorf("claude, no cwd recorded: %q %v", got, ok)
	}
}
