// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2595: a run the launcher set up offers nothing to set up, but the older MoltenTerm hooks of the user's file run
// next to the launcher's, so their update stays offered and says why.
func TestIntegratedRunKeepsOnlyTheUpdateOfOlderHooks(t *testing.T) {
	update := molten.AgentHookOffer{BlockId: "b1", Agent: "claude", Show: true, Persistent: true, Status: molten.HookStatusDefinitionUpdate, UpdateKind: molten.HookUpdateDefinition, CanApply: true}
	if got := integratedHookOffer(update); !got.LauncherAlso || !got.CanApply || !got.Show {
		t.Fatalf("older hooks next to the launcher's: %+v", got)
	}
	for name, offer := range map[string]molten.AgentHookOffer{
		"setup":     {BlockId: "b1", Agent: "claude", Show: true, Persistent: true, Status: molten.HookStatusAbsent, CanApply: true},
		"restart":   {BlockId: "b1", Agent: "claude", Show: true, Persistent: true, Status: molten.HookStatusNotReporting, CanRemove: true},
		"dismissed": {BlockId: "b1", Agent: "claude", Persistent: true, Status: molten.HookStatusDefinitionUpdate, UpdateKind: molten.HookUpdateDefinition, Reason: molten.HookOfferDeclined},
	} {
		got := integratedHookOffer(offer)
		if got.Show || got.Persistent || got.CanApply || got.Reason != molten.HookOfferIntegrated || got.Agent != "claude" {
			t.Fatalf("%s on a launched run: %+v", name, got)
		}
	}
}
