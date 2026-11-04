// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

func TestMoltenSettledSaysWhoWhatAndWhy(t *testing.T) {
	text := formatMoltenSettled(handoffwire.SettleResult{
		Settled: []handoffwire.SettledEntry{{FirstName: "Julien"}, {FirstName: "Léa"}},
		By:      "Arthur",
		Note:    "Backend is flaky, #1874 fixes it",
	})
	for _, want := range []string{"Settled the stop of Julien, Léa, as Arthur.", "Note: Backend is flaky, #1874 fixes it", "a new stop asks again"} {
		if !strings.Contains(text, want) {
			t.Errorf("%q is missing from %q", want, text)
		}
	}
	alone := formatMoltenSettled(handoffwire.SettleResult{Settled: []handoffwire.SettledEntry{{FirstName: "Julien"}}})
	if !strings.Contains(alone, "as you.") || strings.Contains(alone, "Note:") {
		t.Errorf("a terminal without an agent settles as the developer, no note: %q", alone)
	}
}

func TestMoltenDecisionSettleIsUnderAgent(t *testing.T) {
	found, _, err := moltenAgentCmd.Find([]string{"decision", "settle"})
	if err != nil || found != moltenAgentDecisionSettleCmd {
		t.Fatalf("molten agent decision settle: %v %v", found, err)
	}
	if err := moltenAgentDecisionSettleCmd.Args(moltenAgentDecisionSettleCmd, nil); err == nil {
		t.Error("a target is required")
	}
	if moltenAgentDecisionSettleCmd.Flags().Lookup("note") == nil || moltenAgentDecisionSettleCmd.Flags().Lookup("json") == nil {
		t.Error("--note and --json")
	}
}
