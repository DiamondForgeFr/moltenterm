// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"os"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// FR-BOSS-011 AC3 (#2254): the route answers only while the gate the route is started with (Start passes
// buildchannel.BrainstormEnabled) is open, and that gate follows the developer's switches at each call. It changes the
// gate channel by hand, so it is not parallel.
func TestTheRouteRefusesWhileTheBrainstormIsSwitchedOff(t *testing.T) {
	restore := buildchannel.StartAsForTest(buildchannel.Gold, buildchannel.Narrowing{})
	t.Cleanup(restore)
	e := routetest.Make(t)
	f := makeFixture(t)
	link, err := localroute.MakeLink(e.Router, f.service().route(buildchannel.BrainstormEnabled))
	if err != nil {
		t.Fatal(err)
	}
	commands := []string{StateCommand, OpenCommand, CloseCommand, TurnCommand}

	if _, errStr := routetest.Ask(t, link, e.Window(), StateCommand, map[string]any{}); errStr != "" {
		t.Fatalf("a gold with nothing switched off refuses the state: %s", errStr)
	}
	for name, state := range map[string]buildchannel.Narrowing{
		"the brainstorm off": {Off: []string{buildchannel.FeatureBrainstorm}},
		"the public version": {Public: true},
	} {
		buildchannel.UseNarrowing(func() buildchannel.Narrowing { return state })
		for _, command := range commands {
			if _, errStr := routetest.Ask(t, link, e.Window(), command, map[string]any{}); !strings.Contains(errStr, buildchannel.BrainstormRefusal) {
				t.Errorf("%s: %q answered %q, want the plain refusal", name, command, errStr)
			}
		}
		buildchannel.UseNarrowing(func() buildchannel.Narrowing { return buildchannel.Narrowing{} })
		if _, errStr := routetest.Ask(t, link, e.Window(), StateCommand, map[string]any{}); errStr != "" {
			t.Errorf("%s: the route does not answer again once the switch is turned on: %s", name, errStr)
		}
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Errorf("a refused route made folders: %v", entries)
	}
}
