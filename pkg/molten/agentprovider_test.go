// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import "testing"

func TestProviderNames(t *testing.T) {
	cases := map[string]string{
		"api.z.ai":             "GLM",
		"open.bigmodel.cn":     "GLM",
		"api.minimax.io":       "MiniMax",
		"api.minimaxi.com":     "MiniMax",
		"api.deepseek.com":     "DeepSeek",
		"api.moonshot.ai":      "Kimi",
		"openrouter.ai":        "OpenRouter",
		"notz.ai":              "",
		"llm.gateway.internal": "",
		"":                     "",
	}
	for host, want := range cases {
		if got := KnownProviderName(host); got != want {
			t.Errorf("%q: %q, want %q", host, got, want)
		}
	}
	if got := ProviderDisplayName("LLM.Gateway.Internal"); got != "llm.gateway.internal" {
		t.Errorf("an unknown host names itself: %q", got)
	}
}

// The signature never puts an unknown host in a pull request: it may be a private gateway's.
func TestAgentToolSignature(t *testing.T) {
	cases := []struct{ agent, host, want string }{
		{"Claude Code", "", "Claude Code"},
		{"Claude Code", "api.z.ai", "Claude Code via GLM"},
		{"Claude Code", "api.minimax.io", "Claude Code via MiniMax"},
		{"Claude Code", "llm.corp.internal", "Claude Code via another provider"},
		{"", "api.z.ai", ""},
	}
	for _, c := range cases {
		if got := AgentToolSignature(c.agent, c.host); got != c.want {
			t.Errorf("%+v: %q", c, got)
		}
	}
}

func TestCleanProviderHost(t *testing.T) {
	cases := map[string]string{
		"api.z.ai":          "api.z.ai",
		"API.DeepSeek.com":  "api.deepseek.com",
		"api.anthropic.com": "",
		"user:pw@api.z.ai":  "",
		"api.z.ai/api":      "",
		"bad host":          "",
		"localhost:4000":    "localhost",
		"":                  "",
	}
	for in, want := range cases {
		if got := CleanProviderHost(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}
