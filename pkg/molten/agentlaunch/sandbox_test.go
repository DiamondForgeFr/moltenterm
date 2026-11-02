// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"strings"
	"testing"
)

// #989 (TC-SHELL-038-9, TC-SHELL-037-1): the launchers never touch the agents' sandboxes. Opening wavesrv's socket
// there would let every sandboxed command reach all of MoltenTerm; a refused molten command goes through the agent's
// own escalation instead (agentdocs/sandbox-rule.md).
func TestLaunchersLeaveTheSandboxAlone(t *testing.T) {
	tree := makeFakeTree(t)
	forbidden := []string{"default_permissions", "permissions.", "network_proxy", "sandbox_mode", "sandbox_workspace_write", "network_access", "unix_sockets"}
	_, args := codexPlanAll(t, tree.codexCtx())
	for _, a := range args {
		for _, f := range forbidden {
			if strings.Contains(a, f) {
				t.Fatalf("codex: %q touches the sandbox", a)
			}
		}
	}
	plan, _, raw := planOf(t, tree.ctx())
	if _, ok := raw["sandbox"]; ok {
		t.Fatalf("claude: the generated settings set sandbox: %s", raw["sandbox"])
	}
	for _, f := range plan.Files {
		if strings.Contains(string(f.Data), "allowUnixSockets") || strings.Contains(string(f.Data), "allowAllUnixSockets") {
			t.Fatalf("claude: %s opens a socket", f.Prefix)
		}
	}
}
