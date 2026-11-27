// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bytes"
	"encoding/json"
	"path/filepath"
)

// Where a Kimi Code main session works now (#2572). Kimi Code keeps the folder it started in as its session's cwd
// (state.json) for its whole life: a session sent to a ticket's worktree beside the project (../MoltenTerm-1984) works
// there through its tool calls (a Bash call's cwd, git -C <tree>, cd <tree>, an edit of <tree>/file) while state.json
// still names the main checkout. Read from state.json alone, the session's panel stayed on the main checkout's branch,
// the worktree had no panel, and Integration and the companion named its work "an agent" with nowhere to go.

// kimiWorkFolders reads the absolute folders the main agent's tool calls act in, from the end of its wire, the newest
// first.
func kimiWorkFolders(tail []byte) []string {
	var rtn []string
	for end := len(tail); end > 0 && len(rtn) < maxClaudeWorkFolders; {
		start := bytes.LastIndexByte(tail[:end], '\n') + 1
		line := tail[start:end]
		end = start - 1
		if !bytes.Contains(line, []byte(`"tool.call"`)) {
			continue
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil || str(rec, "type") != "context.append_loop_event" {
			continue
		}
		if id := str(rec, "agentId"); id != "" && id != "main" {
			continue
		}
		event := obj(rec, "event")
		if str(event, "type") != "tool.call" {
			continue
		}
		rtn = append(rtn, kimiCallFolders(event)...)
	}
	return rtn
}

// kimiCallFolders: the folders one tool call acts in, the most telling last (they are read newest first): its own cwd,
// else the file it edits or the folders its shell command names.
func kimiCallFolders(event map[string]any) []string {
	if cwd := kimiToolCwd(event); cwd != "" {
		return []string{cwd}
	}
	args := obj(event, "args")
	switch str(event, "name") {
	case "Edit", "Write":
		for _, p := range []string{str(args, "path"), str(obj(event, "display"), "path")} {
			if filepath.IsAbs(p) {
				return []string{filepath.Clean(p)}
			}
		}
	case "Bash":
		folders := commandFolders(str(args, "command"))
		for i, j := 0, len(folders)-1; i < j; i, j = i+1, j-1 {
			folders[i], folders[j] = folders[j], folders[i]
		}
		return folders
	}
	return nil
}

// kimiMainWorkFolder is where a main session works: the newest folder its tool calls act in decides. One in another
// worktree of the session's repository (git worktree list's, wherever it lies on disk) places the session there; one in
// its own checkout brings it back (it checked a worktree and went on with its own work). A folder outside the
// repository says nothing.
func kimiMainWorkFolder(cwd string, folders []string) string {
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
		if root == "" {
			continue
		}
		if root == ownRoot {
			return cwd
		}
		if commonGitDir(findGitDir(root)) == common {
			return root
		}
	}
	return cwd
}
