// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: the coffee and the overrides from a window, the state for the windows and Electron main, the shims and the
// approvals from a local terminal's own link; a remote host forging any of these sources is refused.
func TestRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	f := makeFakeEnv()
	link, err := localroute.MakeLink(e.Router, (&routeLink{s: &service{keeper: f.keeper()}}).route())
	if err != nil {
		t.Fatal(err)
	}
	coffee := map[string]any{"workspaceid": "ws-a", "on": true}
	routetest.MustRefuseWith(t, link, e.NonWindows(), CoffeeCommand, coffee, "from a MoltenTerm window")
	routetest.MustRefuseWith(t, link, e.NonWindows(), OverrideCommand, map[string]any{}, "from a MoltenTerm window")
	routetest.MustRefuseWith(t, link, append([]routetest.From{e.Terminal()}, e.Forged()...), StateCommand, nil, "read by MoltenTerm's windows")
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notTerminals, ShimCommand, map[string]any{}, "from a local MoltenTerm terminal")
	routetest.MustRefuseWith(t, link, notTerminals, PermissionCommand, map[string]any{}, "from a local MoltenTerm terminal")
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		if _, errStr := routetest.Ask(t, link, from, StateCommand, nil); errStr != "" {
			t.Errorf("the state for %s: %s", from.Name, errStr)
		}
	}
}
