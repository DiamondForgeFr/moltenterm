// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// FR-BOSS-010 AC1 (#2320): the route answers a window on every channel, a release candidate and a public release
// included.
func TestTheRouteAnswersOnEveryChannel(t *testing.T) {
	t.Parallel()
	for _, channel := range []string{buildchannel.Dev, buildchannel.Local, buildchannel.Gold, buildchannel.RC, buildchannel.Public} {
		e := routetest.Make(t)
		f := makeFixture(t)
		link, err := localroute.MakeLink(e.Router, f.service().route(func() bool { return buildchannel.BrainstormAllowed(channel) }))
		if err != nil {
			t.Fatal(err)
		}
		if _, errStr := routetest.Ask(t, link, e.Window(), StateCommand, map[string]any{}); errStr != "" {
			t.Errorf("the state on channel %q: %s", channel, errStr)
		}
	}
}

// FR-BOSS-010 AC1 (#2320): the gate Start passes (buildchannel.BrainstormEnabled) answers on every channel whatever the
// developer stored in Features in test: a state left by a gold, which switched the brainstorm or every gated feature
// off, closes nothing. It changes the gate channel by hand, so it is not parallel.
func TestTheRouteIgnoresWhatFeaturesInTestStored(t *testing.T) {
	stale := map[string]buildchannel.Narrowing{
		"nothing stored":     {},
		"the brainstorm off": {Off: []string{"brainstorm"}},
		"the public version": {Public: true},
	}
	for _, channel := range []string{buildchannel.Gold, buildchannel.RC, buildchannel.Public} {
		for name, state := range stale {
			restore := buildchannel.StartAsForTest(channel, state)
			e := routetest.Make(t)
			f := makeFixture(t)
			link, err := localroute.MakeLink(e.Router, f.service().route(buildchannel.BrainstormEnabled))
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{StateCommand, OpenCommand, CloseCommand, TurnCommand} {
				if _, errStr := routetest.Ask(t, link, e.Window(), command, map[string]any{}); strings.Contains(errStr, buildchannel.BrainstormRefusal) {
					t.Errorf("%s on %q: %q refused with %q", name, channel, command, errStr)
				}
			}
			restore()
		}
	}
}
