// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"slices"
	"testing"
)

func TestLocalShellBaseEnvDropsAgentSessionMarkers(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	t.Setenv("MOLTEN_TEST_KEEP", "kept")
	env := localShellBaseEnv()
	for _, kv := range env {
		switch kv {
		case "CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "CLAUDE_CODE_ENTRYPOINT=cli":
			t.Fatalf("local shell env still holds %q", kv)
		}
	}
	for _, kv := range []string{"CLAUDE_CODE_USE_BEDROCK=1", "MOLTEN_TEST_KEEP=kept"} {
		if !slices.Contains(env, kv) {
			t.Fatalf("local shell env lost %q", kv)
		}
	}
}
