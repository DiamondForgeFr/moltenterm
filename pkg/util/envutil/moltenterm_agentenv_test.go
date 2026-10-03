// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package envutil

import (
	"slices"
	"testing"
)

func TestStripAgentSessionMarkers(t *testing.T) {
	env := []string{
		"HOME=/Users/me",
		"CLAUDECODE=1",
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_ENTRYPOINT=cli",
		"CLAUDE_CODE_SSE_PORT=12345",
		"CLAUDE_CODE_SESSION_ID=abc",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000",
		"CODEX_SANDBOX=seatbelt",
		"GEMINI_CLI=1",
		"PATH=/usr/bin:/bin",
		"WEIRD=a=b",
	}
	got := StripAgentSessionMarkers(env)
	want := []string{
		"HOME=/Users/me",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000",
		"PATH=/usr/bin:/bin",
		"WEIRD=a=b",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("StripAgentSessionMarkers() = %v, want %v", got, want)
	}
}

func TestStripAgentSessionMarkersMap(t *testing.T) {
	envMap := map[string]string{
		"CLAUDECODE":                "1",
		"CLAUDE_CODE_CHILD_SESSION": "1",
		"CLAUDE_CODE_USE_BEDROCK":   "1",
		"SHELL":                     "/bin/zsh",
	}
	got := StripAgentSessionMarkersMap(envMap)
	if len(got) != 2 || got["CLAUDE_CODE_USE_BEDROCK"] != "1" || got["SHELL"] != "/bin/zsh" {
		t.Fatalf("StripAgentSessionMarkersMap() = %v", got)
	}
	if _, ok := envMap["CLAUDECODE"]; !ok {
		t.Fatalf("StripAgentSessionMarkersMap() changed its input")
	}
}
