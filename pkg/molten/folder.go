// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A workspace works in one folder (FR-SHELL-009, DS-SHELL-009): the folder its focused local terminal went to, kept
// in the workspace's meta. Once the workspace is linked to a project, the folder stays inside the project: a folder
// outside it stands for the project's root. Every new block of the workspace without a place of its own starts there.

// must match the key in frontend/moltenterm-shell/workspace-project.ts
const WorkspaceFolderMetaKey = "molten:folder"

// must match WorkspaceRecentFoldersMetaKey in frontend/moltenterm-shell/workspace-project.ts and MaxRecentFolders in
// frontend/moltenterm-shell/palette/palette-sources.ts
const WorkspaceRecentFoldersMetaKey = "molten:recentfolders"
const MaxRecentFolders = 8

// PushRecentFolder puts folder first in a workspace's recent folders, as read from its meta (any JSON value), without
// a duplicate, keeping MaxRecentFolders at most. The command palette offers them (FR-SHELL-013).
func PushRecentFolder(recent any, folder string) []string {
	list := []string{}
	if folder != "" {
		list = append(list, folder)
	}
	values, _ := recent.([]any)
	for _, value := range values {
		f, ok := value.(string)
		if !ok || f == "" || f == folder {
			continue
		}
		list = append(list, f)
	}
	if len(list) > MaxRecentFolders {
		list = list[:MaxRecentFolders]
	}
	return list
}

// CheckPathInside reports whether path is dir or lies below it.
func CheckPathInside(path string, dir string) bool {
	if path == "" || dir == "" {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(path))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// WorkspaceFolder returns the folder new blocks of a workspace start in, or "" when it has none.
func WorkspaceFolder(meta waveobj.MetaMapType) string {
	folder := meta.GetString(WorkspaceFolderMetaKey, "")
	project := meta.GetString(ProjectMetaKey, "")
	if project != "" && !CheckPathInside(folder, project) {
		return project
	}
	return folder
}

func checkLocalConnName(connName string) bool {
	return connName == "" || connName == "local" || strings.HasPrefix(connName, "local:")
}

// BlockMetaInFolder returns the meta of a new block started in folder, and whether it differs from blockMeta (which is
// never modified). Only blocks without a place of their own move: a local shell terminal without cmd:cwd, a local file
// view without file. A split or duplicated terminal carries its source's folder and keeps it.
func BlockMetaInFolder(blockMeta waveobj.MetaMapType, folder string) (waveobj.MetaMapType, bool) {
	if folder == "" || blockMeta == nil || !checkLocalConnName(blockMeta.GetString(waveobj.MetaKey_Connection, "")) {
		return blockMeta, false
	}
	var key string
	switch blockMeta.GetString(waveobj.MetaKey_View, "") {
	case "term":
		if blockMeta.GetString(waveobj.MetaKey_Controller, "") == "shell" {
			key = waveobj.MetaKey_CmdCwd
		}
	case "preview":
		key = waveobj.MetaKey_File
	}
	if key == "" || blockMeta.GetString(key, "") != "" {
		return blockMeta, false
	}
	rtn := make(waveobj.MetaMapType, len(blockMeta)+1)
	for k, v := range blockMeta {
		rtn[k] = v
	}
	rtn[key] = folder
	return rtn, true
}
