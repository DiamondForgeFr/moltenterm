// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: a remote host forging a tab source no longer reads local agents' conversations, and a terminal reports a
// session or a status line for its own block only.
func TestRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{}).route())
	if err != nil {
		t.Fatal(err)
	}
	view := map[string]any{"blockid": "b1", "viewid": "v1", "path": "/etc/hosts"}
	for _, command := range []string{
		molten.CompanionOpenCommand, molten.CompanionCloseCommand, molten.CompanionPickCommand, molten.CompanionSessionsCommand,
		molten.CompanionAnswerCommand, molten.CompanionDiffCommand, molten.CompanionUsageCommand, molten.CompanionUsageGaugesCommand,
		molten.CompanionUsageExperimentalCommand,
	} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, view)
	}
	report := map[string]any{"blockid": routetest.TerminalBlock, "agent": "claude", "path": "/etc/hosts"}
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	for _, command := range []string{molten.CompanionSessionCommand, molten.AgentStatusLineCommand} {
		routetest.MustRefuseWith(t, link, notTerminals, command, report, "no companion for a remote terminal")
		other := map[string]any{"blockid": "block-other", "agent": "claude", "path": "/etc/hosts"}
		if _, errStr := routetest.Ask(t, link, e.Terminal(), command, other); !strings.Contains(errStr, "its own block") {
			t.Errorf("%s for another terminal's block: %q", command, errStr)
		}
	}
}
