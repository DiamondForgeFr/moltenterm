// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import "regexp"

// GitHubTokenMask replaces a GitHub token in the text MoltenTerm keeps or shows (DS-REV-011).
const GitHubTokenMask = "<github-token>"

// GitHubTokenRe matches GitHub's token formats: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained (github_pat_).
var GitHubTokenRe = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`)

// MaskGitHubTokens hides anything shaped like a GitHub token in a message kept or shown: gh's errors, a PR's text.
func MaskGitHubTokens(text string) string {
	return GitHubTokenRe.ReplaceAllString(text, GitHubTokenMask)
}
