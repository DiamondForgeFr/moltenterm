// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"strings"
	"testing"
)

// The drafted changelog step says what its section covers (#1142), so the agent writing it gets the scope too.
func TestChangelogStepSaysItsScope(t *testing.T) {
	public := changelogStep("docs/changelog.md", "changelog-en", "In the release worktree", ChannelPublic)
	if !strings.Contains(public.Manual, "since the last public release, release candidates included") {
		t.Fatalf("public: %q", public.Manual)
	}
	rc := changelogStep("docs/changelog.md", "changelog-en", "In the release worktree", ChannelRc)
	if !strings.Contains(rc.Manual, "since the previous release, candidate or public") || strings.Contains(rc.Manual, "release candidates included") {
		t.Fatalf("rc: %q", rc.Manual)
	}
}
