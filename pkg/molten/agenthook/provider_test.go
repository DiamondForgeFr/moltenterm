// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"encoding/json"
	"testing"
)

func TestBaseUrlProviderHost(t *testing.T) {
	cases := map[string]string{
		"":                                    "",
		"https://api.anthropic.com":           "",
		"https://api.anthropic.com/":          "",
		"https://api.z.ai/api/anthropic":      "api.z.ai",
		"https://API.MiniMax.io/anthropic":    "api.minimax.io",
		"https://api.deepseek.com/anthropic":  "api.deepseek.com",
		"api.z.ai/api/anthropic":              "api.z.ai",
		"http://localhost:4000":               "localhost",
		"https://user:secret@gw.example.com/": "gw.example.com",
		"https://api.z.ai./api":               "api.z.ai",
		"https://bad host/":                   "",
		"::::":                                "",
	}
	for in, want := range cases {
		if got := BaseUrlProviderHost(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// Only ANTHROPIC_BASE_URL is read, and only for Claude Code: the token is never looked at.
func TestProviderHostForReadsTheBaseUrlOnly(t *testing.T) {
	var read []string
	getenv := func(name string) string {
		read = append(read, name)
		if name == ClaudeBaseUrlVar {
			return "https://api.z.ai/api/anthropic"
		}
		return "secret"
	}
	if got := ProviderHostFor("claude", getenv); got != "api.z.ai" {
		t.Fatalf("claude: %q", got)
	}
	if got := ProviderHostFor("codex", getenv); got != "" {
		t.Fatalf("codex: %q", got)
	}
	if len(read) != 1 || read[0] != ClaudeBaseUrlVar {
		t.Fatalf("read %v", read)
	}
}

// A SessionStart behind another provider tells wavesrv the provider with the start report.
func TestSessionStartCarriesTheProvider(t *testing.T) {
	var sent []AgentStateRequest
	call := func(command string, route string, data any) error {
		if command == AgentStateSetCommand {
			raw, _ := json.Marshal(data)
			var req AgentStateRequest
			json.Unmarshal(raw, &req)
			sent = append(sent, req)
		}
		return nil
	}
	input := HookInput{HookEventName: HookEventSessionStart, Source: "startup", SessionId: "s", Provider: "api.z.ai"}
	if err := RunHookEvent(input, "claude", "b1", call); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || !sent[0].Start || sent[0].Provider != "api.z.ai" {
		t.Fatalf("sent %+v", sent)
	}
}
