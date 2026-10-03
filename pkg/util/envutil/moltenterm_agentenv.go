// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package envutil

import "strings"

// AgentSessionMarkers are the variables a CLI agent sets for the processes it spawns to mark them as part of its
// session. When MoltenTerm is launched from inside such a session (e.g. `task dev` run by Claude Code), wavesrv inherits
// them and so would every local shell: an agent started there then believes it is a child of the first one (Claude
// Code turns transcript saving off on CLAUDE_CODE_CHILD_SESSION).
//
// An explicit denylist rather than a CLAUDE_CODE_* prefix strip: that prefix also holds user configuration exported
// from shell rc files (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_MAX_OUTPUT_TOKENS...), which must survive. Each name was
// checked against the agent: Claude Code from the environment of its Bash tool and its binary (2.1.x), Codex from
// codex-rs/core/src/spawn.rs, Gemini CLI from packages/core/src/services/shellExecutionService.ts.
var AgentSessionMarkers = map[string]bool{
	// Claude Code
	"CLAUDECODE":                   true,
	"CLAUDE_CODE_ENTRYPOINT":       true,
	"CLAUDE_CODE_CHILD_SESSION":    true,
	"CLAUDE_CODE_SESSION_ID":       true,
	"CLAUDE_CODE_SESSION_ATTENDED": true,
	"CLAUDE_CODE_SSE_PORT":         true,
	"CLAUDE_CODE_EXECPATH":         true,
	"CLAUDE_CODE_MESSAGING_SOCKET": true,
	"CLAUDE_CODE_MESSAGING_TOKEN":  true,
	"CLAUDE_PID":                   true,
	"CLAUDE_EFFORT":                true,
	"AI_AGENT":                     true,
	// Codex
	"CODEX_SANDBOX":                  true,
	"CODEX_SANDBOX_NETWORK_DISABLED": true,
	// Gemini CLI
	"GEMINI_CLI": true,
}

// StripAgentSessionMarkers returns env ("KEY=VALUE" entries) without the agent session markers.
func StripAgentSessionMarkers(env []string) []string {
	rtn := make([]string, 0, len(env))
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		if AgentSessionMarkers[key] {
			continue
		}
		rtn = append(rtn, kv)
	}
	return rtn
}

// StripAgentSessionMarkersMap returns a copy of envMap without the agent session markers.
func StripAgentSessionMarkersMap(envMap map[string]string) map[string]string {
	rtn := make(map[string]string, len(envMap))
	for key, value := range envMap {
		if AgentSessionMarkers[key] {
			continue
		}
		rtn[key] = value
	}
	return rtn
}
