// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

// FR-SHELL-040-AC1: settings that turn the integration off keep the run as the user started it, with nothing written.
func TestPlanMoltenAgentLaunchSettingsGate(t *testing.T) {
	env, data := launchEnv(t)
	getenv := func(name string) string { return env[name] }
	gate := func() string { return agentlaunch.StepAsideSettingsAgentOff }
	report, args, _ := planMoltenAgentLaunchWith(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"-p", "hi"}, getenv, time.Now(), gate)
	if report.StepAside != agentlaunch.StepAsideSettingsAgentOff || report.Added != nil || report.Skipped != nil || report.Settings != "" {
		t.Fatalf("report %+v", report)
	}
	if !slices.Equal(args, []string{"-p", "hi"}) {
		t.Fatalf("args %q", args)
	}
	if entries, _ := os.ReadDir(agentlaunch.LaunchDir(data)); len(entries) != 0 {
		t.Fatalf("nothing may be written when the settings turn the integration off: %v", entries)
	}
	report, args, _ = planMoltenAgentLaunchWith(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"-p", "hi"}, getenv, time.Now(), func() string { return "" })
	if report.StepAside != "" || len(args) != 4 || args[0] != "--settings" {
		t.Fatalf("an open gate integrates: %+v %q", report, args)
	}
}

func TestMoltenLaunchSettingsStepAside(t *testing.T) {
	off := false
	ch := make(chan *agentlaunch.IntegrationSettings, 1)
	ch <- &agentlaunch.IntegrationSettings{Integrate: &off}
	if got := moltenLaunchSettingsStepAside(ch, "codex", time.Now().Add(time.Second)); got != agentlaunch.StepAsideSettingsOff {
		t.Errorf("off: %q", got)
	}
	ch <- &agentlaunch.IntegrationSettings{Off: []string{"codex"}}
	if got := moltenLaunchSettingsStepAside(ch, "claude", time.Now().Add(time.Second)); got != "" {
		t.Errorf("claude keeps it: %q", got)
	}
	ch <- nil
	if got := moltenLaunchSettingsStepAside(ch, "claude", time.Now().Add(time.Second)); got != agentlaunch.StepAsideSettingsUnknown {
		t.Errorf("unread settings: %q", got)
	}
	start := time.Now()
	if got := moltenLaunchSettingsStepAside(make(chan *agentlaunch.IntegrationSettings), "claude", start.Add(20*time.Millisecond)); got != agentlaunch.StepAsideSettingsUnknown {
		t.Errorf("no answer: %q", got)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Errorf("the wait must end at the deadline")
	}
}

// A launch that cannot connect answers at once: no settings, and the report's connection says so.
func TestMoltenLaunchSettingsNotConnected(t *testing.T) {
	connected := make(chan bool, 1)
	connected <- false
	settings, relay := moltenLaunchSettings(connected, time.Now().Add(time.Second))
	if ok := <-relay; ok {
		t.Fatalf("relay must say not connected")
	}
	if s := <-settings; s != nil {
		t.Fatalf("settings %+v", s)
	}
}

// FR-SHELL-040-AC4: the status applies the settings and names the ignored ids.
func TestMoltenPlannedIntegrationSettings(t *testing.T) {
	launch := agentlaunch.FindAdapter("claude")
	off := false
	cases := []struct {
		settings *agentlaunch.IntegrationSettings
		want     string
	}{
		{&agentlaunch.IntegrationSettings{Integrate: &off}, agentlaunch.StepAsideSettingsOff},
		{&agentlaunch.IntegrationSettings{Off: []string{"claude"}}, agentlaunch.StepAsideSettingsAgentOff},
		{nil, agentlaunch.StepAsideSettingsUnknown},
	}
	for _, c := range cases {
		report := moltenSettingsReport(launch, c.settings)
		if report != c.want {
			t.Errorf("settings %+v: %q, want %q", c.settings, report, c.want)
		}
	}
	note := moltenUnknownOffNote(&agentlaunch.IntegrationSettings{Off: []string{"gemini", "codex"}})
	if !strings.Contains(note, "gemini") || strings.Contains(note, "codex") {
		t.Errorf("note %q", note)
	}
	if out := formatMoltenIntegrationStatus(MoltenIntegrationStatus{Note: note}); !strings.HasPrefix(out, "Note: agent:integrateoff lists gemini") {
		t.Errorf("format %q", out)
	}
}
