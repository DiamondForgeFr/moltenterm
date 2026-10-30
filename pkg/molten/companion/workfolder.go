// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"path/filepath"
)

// Where a main agent session works (#1476): a session sent to a ticket's worktree does its work there while its
// terminal stays in the main checkout. Integration and the sidebar place its panel on that worktree's branch, through
// its agent's adapter (WorkFolderReader); an agent without one is placed by its terminal's folder.

// WorkFolder reads where a Codex session works now: the folder of its newest shell command when that folder is in a
// repository, else its latest turn's folder (its header's when none is recorded). Unlike a sub-agent's
// (codexWorkFolder), a main session's newest command decides: one that checks a worktree and goes back to its own
// checkout is back there with its next command.
func (a *CodexAdapter) WorkFolder(sessionPath string) (string, bool) {
	tail, err := readFileTail(sessionPath, codexSubagentTail)
	if err != nil {
		return "", false
	}
	cwd, _, folders := codexLastTurn(tail)
	if cwd == "" {
		if head, ok := a.head(sessionPath); ok {
			cwd = head.cwd
		}
	}
	if len(folders) > 0 {
		if f := absFolder(cwd, folders[0]); f != "" && findGitDir(f) != "" {
			return f, true
		}
	}
	if !filepath.IsAbs(cwd) {
		return "", false
	}
	return filepath.Clean(cwd), true
}

// WorkFolder reads where a Claude Code session works now: its latest record's cwd, which follows the session into a
// worktree (EnterWorktree, a cd its shell keeps).
func (a *ClaudeAdapter) WorkFolder(sessionPath string) (string, bool) {
	tail, err := readFileTail(sessionPath, claudeSubagentTailBytes)
	if err != nil {
		return "", false
	}
	cwd := claudeTailFacts(tail, true).cwd
	if !filepath.IsAbs(cwd) {
		return "", false
	}
	return filepath.Clean(cwd), true
}

// absFolder is a command's folder made absolute against its turn's folder; "" when neither is absolute.
func absFolder(cwd string, folder string) string {
	if filepath.IsAbs(folder) {
		return filepath.Clean(folder)
	}
	if !filepath.IsAbs(cwd) {
		return ""
	}
	return filepath.Join(cwd, folder)
}

// PaneWorkFolder is where the agent of a terminal works now, read by its adapter from the session the terminal runs;
// "" when its adapter reads none or no session is known.
func PaneWorkFolder(blockId string) string {
	m := defaultManager
	if m == nil {
		return ""
	}
	return m.PaneWorkFolder(blockId, HookSubagents(blockId))
}

func (m *Manager) PaneWorkFolder(blockId string, hooks []SubagentHookEvent) string {
	agent, path, ok := m.LinkedSession(blockId)
	if !ok && len(hooks) > 0 {
		agent = hooks[len(hooks)-1].Agent
		if agent == "" && m.runOf != nil {
			if run, ok := m.runOf(blockId); ok {
				agent = run.Agent
			}
		}
	}
	adapter := m.identityAdapter(agent)
	if adapter == nil {
		return ""
	}
	if !ok {
		path = hookSessionPath(adapter, hooks)
	}
	reader, isReader := adapter.(WorkFolderReader)
	if path == "" || !isReader {
		return ""
	}
	folder, _ := reader.WorkFolder(path)
	return folder
}
