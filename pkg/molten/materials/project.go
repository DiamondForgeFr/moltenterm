// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A drawer's key (DS-MAT-001) is a fingerprint of the main repository's root folder: a worktree and its main checkout
// share one drawer, and a renamed workspace keeps its materials. The git files are read, no git process runs.

var projectKeyRegex = regexp.MustCompile(`^(?:[0-9a-f]{16}|` + molten.MaterialsNoProject + `)$`)

func validProjectKey(key string) bool {
	return projectKeyRegex.MatchString(key)
}

// MainRoot is the folder a project folder's materials belong to: the main checkout of its repository (a linked
// worktree is mapped back through the git common folder), its git root, or the folder itself.
func MainRoot(folder string) string {
	if folder == "" {
		return ""
	}
	folder = filepath.Clean(folder)
	root := molten.FindGitRoot(folder)
	if root == "" {
		return folder
	}
	if main := molten.MainCheckoutOfTree(root); main != "" {
		return filepath.Clean(main)
	}
	return root
}

// ProjectKey is the drawer of a project folder ("" gives No project) and the folder it names.
func ProjectKey(folder string) (string, string) {
	root := MainRoot(folder)
	if root == "" {
		return molten.MaterialsNoProject, ""
	}
	sum := sha256.Sum256([]byte(realOrClean(root)))
	return hex.EncodeToString(sum[:])[:16], root
}
