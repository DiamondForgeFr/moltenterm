// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: the agent states (every terminal's command line) go to the windows and Electron main only, and only a window
// answers a hook offer; a remote host's hook still reports.
func TestAgentRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, agentRoute)
	if err != nil {
		t.Fatal(err)
	}
	routetest.MustRefuse(t, link, append([]routetest.From{e.Terminal()}, e.Forged()...), molten.AgentStatesCommand, nil)
	for _, command := range []string{molten.AgentHookOfferCommand, molten.AgentHookDismissCommand, molten.AgentStatesDocCommand} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, map[string]any{"blockid": "b1", "agent": "claude"})
	}
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		if _, errStr := routetest.Ask(t, link, from, molten.AgentStatesCommand, nil); errStr != "" {
			t.Errorf("the states for %s: %s", from.Name, errStr)
		}
	}
	for _, from := range append([]routetest.From{e.Terminal()}, e.Forged()...) {
		if _, errStr := routetest.Ask(t, link, from, molten.AgentIntegrationStatusCommand, map[string]any{"blockid": "b1"}); errStr != "" {
			t.Errorf("the integration status for %s: %s", from.Name, errStr)
		}
	}
}
