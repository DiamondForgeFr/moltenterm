// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Where a Claude Code sub-agent works when its records do not say it (#2522). A sub-agent started without a worktree
// of its own keeps its lead's folder as its records' cwd, and Claude Code resets that folder after each command: one
// sent to a worktree outside .claude/worktrees (a sibling folder, ../Notulia-1320) does its work there through absolute
// paths (git -C <tree>, <tree>/script, an edit of <tree>/file) while every record names the lead's checkout. Its
// branch, and so its ticket, are that worktree's. Only what changes or drives the worktree counts: a read or a search
// in another worktree (a reviewer's) does not move the agent there.

const (
	// The folders kept from the end of a transcript, the newest first.
	maxClaudeWorkFolders = 16
	maxClaudeCommandText = 8 * 1024
)

// claudeToolInput is what a tool call says of the folder it acts in.
type claudeToolInput struct {
	FilePath     string `json:"file_path"`
	NotebookPath string `json:"notebook_path"`
	Command      string `json:"command"`
}

type claudeContentItem struct {
	Type  string          `json:"type"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// claudeWriteTools are the tools whose path is where the agent changes files.
var claudeWriteTools = map[string]bool{"Edit": true, "MultiEdit": true, "Write": true, "NotebookEdit": true}

// claudeToolFolders reads the absolute paths an assistant record's tool calls act in, in the order of the calls: an
// edited file, a git -C or cd folder, a command run by its absolute path.
func claudeToolFolders(content json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(content))
	if !strings.HasPrefix(trimmed, "[") {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(content, &items) != nil {
		return nil
	}
	var rtn []string
	for _, raw := range items {
		var item claudeContentItem
		if json.Unmarshal(raw, &item) != nil || item.Type != "tool_use" || len(item.Input) == 0 {
			continue
		}
		var input claudeToolInput
		if json.Unmarshal(item.Input, &input) != nil {
			continue
		}
		if claudeWriteTools[item.Name] {
			for _, p := range []string{input.FilePath, input.NotebookPath} {
				if filepath.IsAbs(p) {
					rtn = append(rtn, filepath.Clean(p))
				}
			}
			continue
		}
		if item.Name == "Bash" {
			rtn = append(rtn, commandFolders(input.Command)...)
		}
	}
	return rtn
}

// commandFolders reads the absolute folders a shell command acts in: git -C <dir>, cd <dir>, and a program run by its
// absolute path. Any other path (an argument the command reads) does not say where the agent works.
func commandFolders(command string) []string {
	if len(command) > maxClaudeCommandText {
		command = command[:maxClaudeCommandText]
	}
	var rtn []string
	for _, part := range splitShellParts(command) {
		fields := strings.Fields(part)
		for i, f := range fields {
			f = shellUnquote(f)
			switch {
			case i == 0 && filepath.IsAbs(f):
				rtn = append(rtn, filepath.Clean(f))
			case (f == "-C" && i > 0 && shellUnquote(fields[i-1]) == "git") || (f == "cd" && i == 0):
				if i+1 < len(fields) {
					if dir := shellUnquote(fields[i+1]); filepath.IsAbs(dir) {
						rtn = append(rtn, filepath.Clean(dir))
					}
				}
			}
		}
	}
	return rtn
}

// splitShellParts cuts a command line at its separators (&&, ||, ;, |, newlines) so that each part's first word is
// the program it runs.
func splitShellParts(command string) []string {
	return strings.FieldsFunc(command, func(r rune) bool {
		return r == '&' || r == '|' || r == ';' || r == '\n'
	})
}

func shellUnquote(s string) string {
	return strings.Trim(s, "\"'")
}

// claudeSubagentWorkFolder is the worktree a sub-agent works in: the root of the newest folder its tool calls act in
// that is another worktree of its records' repository (git worktree list's, wherever it lies on disk), else its
// records' cwd. A folder of another repository never counts: the agent only looked there.
func claudeSubagentWorkFolder(cwd string, folders []string) string {
	if !filepath.IsAbs(cwd) {
		return cwd
	}
	cwd = filepath.Clean(cwd)
	ownRoot := worktreeRoot(cwd)
	if ownRoot == "" {
		return cwd
	}
	common := commonGitDir(findGitDir(ownRoot))
	if common == "" {
		return cwd
	}
	for _, f := range folders {
		root := worktreeRoot(f)
		if root == "" || root == ownRoot {
			continue
		}
		if commonGitDir(findGitDir(root)) == common {
			return root
		}
	}
	return cwd
}

// worktreeRoot is the folder holding the .git (folder or file) of the repository or worktree path lies in; "" when it
// lies in none.
func worktreeRoot(path string) string {
	if !filepath.IsAbs(path) {
		return ""
	}
	dir := filepath.Clean(path)
	for i := 0; i < maxGitDirDepth; i++ {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

// commonGitDir is the repository's own git folder a worktree's git folder belongs to (its commondir file), the folder
// itself for a main checkout.
func commonGitDir(gitDir string) string {
	if gitDir == "" {
		return ""
	}
	text, ok := readSmallFile(filepath.Join(gitDir, "commondir"))
	if !ok {
		return filepath.Clean(gitDir)
	}
	common := strings.TrimSpace(text)
	if common == "" {
		return filepath.Clean(gitDir)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(gitDir, common)
	}
	return filepath.Clean(common)
}
