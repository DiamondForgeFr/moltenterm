// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package reviewsession

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// #2514: a terminal MoltenTerm opens for an agent tells that agent its SaaSFoundryAI identity.
func TestWithSfAgentMeta(t *testing.T) {
	cases := []struct {
		line string
		want string
	}{
		{CommandLine("kimi", []string{"--", "Restart the work"}), "kimi"},
		{CommandLine("claude", []string{"--", "Lead"}), "claude-code"},
		{CommandLine("codex", []string{"--", "Lead"}), "codex"},
	}
	for _, tc := range cases {
		own := map[string]any{"MOLTEN_OWN": "1"}
		meta := waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_CmdEnv: own}
		got := WithSfAgentMeta(meta, tc.line)
		env, ok := got[waveobj.MetaKey_CmdEnv].(map[string]any)
		if !ok || env[molten.SfAgentEnvVar] != tc.want || env["MOLTEN_OWN"] != "1" || got[waveobj.MetaKey_View] != "term" {
			t.Errorf("%q: meta = %v", tc.line, got)
		}
		if _, changed := own[molten.SfAgentEnvVar]; changed || len(meta) != 2 {
			t.Errorf("%q: the caller's meta changed: %v", tc.line, meta)
		}
	}
	plain := waveobj.MetaMapType{waveobj.MetaKey_View: "term"}
	for _, line := range []string{CommandLine("less", []string{"-R", "log"}), CommandLine("opencode", nil)} {
		if got := WithSfAgentMeta(plain, line); got[waveobj.MetaKey_CmdEnv] != nil {
			t.Errorf("%q has no identity to hand: %v", line, got)
		}
	}
}
