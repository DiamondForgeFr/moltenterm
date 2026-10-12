// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"slices"
	"testing"
)

func TestIntegrationSettingsStepAside(t *testing.T) {
	on, off := true, false
	cases := []struct {
		name  string
		s     IntegrationSettings
		agent string
		want  string
	}{
		{"default is on", IntegrationSettings{}, ClaudeAgentId, ""},
		{"explicitly on", IntegrationSettings{Integrate: &on}, CodexAgentId, ""},
		{"off for every agent", IntegrationSettings{Integrate: &off}, ClaudeAgentId, StepAsideSettingsOff},
		{"off wins over the list", IntegrationSettings{Integrate: &off, Off: []string{"codex"}}, ClaudeAgentId, StepAsideSettingsOff},
		{"codex only: codex", IntegrationSettings{Off: []string{"codex"}}, CodexAgentId, StepAsideSettingsAgentOff},
		{"codex only: claude keeps it", IntegrationSettings{Off: []string{"codex"}}, ClaudeAgentId, ""},
	}
	for _, c := range cases {
		if got := c.s.StepAside(c.agent); got != c.want {
			t.Errorf("%s: StepAside(%q) = %q, want %q", c.name, c.agent, got, c.want)
		}
	}
}

func TestIntegrationSettingsUnknownOff(t *testing.T) {
	s := IntegrationSettings{Off: []string{"gemini", "codex", "Claude", "gemini"}}
	if got := s.UnknownOff(); !slices.Equal(got, []string{"Claude", "gemini"}) {
		t.Errorf("UnknownOff() = %v", got)
	}
	if got := (IntegrationSettings{Off: []string{"claude"}}).UnknownOff(); got != nil {
		t.Errorf("UnknownOff() of known ids = %v", got)
	}
}
