// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: no terminal, local or remote, types into a terminal, steps an agent's permission mode up, restarts or
// interrupts it; a window still does.
func TestRouteAnswersWindowsOnly(t *testing.T) {
	e := routetest.Make(t)
	s := &service{}
	link, err := localroute.MakeLink(e.Router, s.route())
	if err != nil {
		t.Fatal(err)
	}
	req := map[string]any{"blockid": "block-other", "action": "mode", "confirmed": true}
	for _, command := range []string{ListCommand, CheckCommand, RunCommand, AgentInputInfoCommand, AgentInputCommand, AgentRestartCommand} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, req)
	}
	ownBlock := map[string]any{"blockid": routetest.TerminalBlock, "confirmed": true}
	routetest.MustRefuse(t, link, []routetest.From{e.Terminal()}, AgentInputCommand, ownBlock)
	if _, errStr := routetest.Ask(t, link, e.Window(), ListCommand, nil); errStr != "" {
		t.Fatalf("the window's list: %s", errStr)
	}
}
