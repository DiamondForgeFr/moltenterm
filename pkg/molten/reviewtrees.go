// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strconv"
	"strings"
)

// Where MoltenTerm keeps a project's review worktrees (DS-REV-004): <data>/molten/worktrees/<project>-<hash>/review-<N>.
// Here so that Mission Control's leftovers (#1121) find them without the review session's package.

const reviewTreePrefix = "review-"

// ReviewTreesDir is the folder of a project's review worktrees.
func ReviewTreesDir(dataDir string, projectDir string) string {
	sum := sha256.Sum256([]byte(projectDir))
	name := filepath.Base(projectDir) + "-" + hex.EncodeToString(sum[:4])
	return filepath.Join(dataDir, "molten", "worktrees", name)
}

// ReviewTreeNumber is the PR number of a review worktree's folder name ("review-1094"), 0 when it is not one.
func ReviewTreeNumber(name string) int {
	digits, ok := strings.CutPrefix(name, reviewTreePrefix)
	if !ok || digits == "" || len(digits) > 9 || digits[0] == '0' {
		return 0
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}
