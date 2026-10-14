// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

func TestMaskGitHubTokens(t *testing.T) {
	for _, token := range []string{
		"ghp_abcdefghijklmnopqrstuvwxyz0123", "gho_abcdefghijklmnopqrstuvwxyz0123", "ghu_abcdefghijklmnopqrst",
		"ghs_ABCDEFGHIJKLMNOPQRST1234", "ghr_abcdefghijklmnopqrst", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
	} {
		got := MaskGitHubTokens("HTTP 401 (token " + token + ")")
		if strings.Contains(got, token) || got != "HTTP 401 (token "+GitHubTokenMask+")" {
			t.Errorf("%s: %q", token, got)
		}
	}
	for _, kept := range []string{"ghp_short", "the ghost_of_a_branch", "xghp_abcdefghijklmnopqrstuvwxyz"} {
		if got := MaskGitHubTokens(kept); got != kept {
			t.Errorf("%q masked: %q", kept, got)
		}
	}
}
