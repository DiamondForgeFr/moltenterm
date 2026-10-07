// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import "testing"

// FR-SHELL-038 AC8: a run that only got the browser server (the user's own -c notify) still gets the hook setup
// offer; one whose states MoltenTerm reports does not.
func TestReportsStates(t *testing.T) {
	browser := IntegrationItem{Kind: IntegrationBrowser, Name: "MoltenTerm browser"}
	cases := []struct {
		report AgentIntegrationReport
		want   bool
	}{
		{AgentIntegrationReport{Added: []IntegrationItem{browser}}, false},
		{AgentIntegrationReport{Added: []IntegrationItem{browser, {Kind: IntegrationNotify}}}, true},
		{AgentIntegrationReport{Added: []IntegrationItem{{Kind: IntegrationStateHooks}}}, true},
		{AgentIntegrationReport{Added: []IntegrationItem{{Kind: IntegrationNotify}}, StepAside: "off"}, false},
		{AgentIntegrationReport{Added: []IntegrationItem{{Kind: IntegrationSession}}}, false},
	}
	for i, c := range cases {
		if got := c.report.ReportsStates(); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
}
