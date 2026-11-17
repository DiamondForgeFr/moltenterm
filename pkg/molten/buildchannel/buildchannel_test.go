// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import (
	"os"
	"testing"
)

// FR-BOSS-010 AC1 (#2320): every channel has the brainstorm, a release candidate and a public release included; an
// unknown channel and no channel at all are refused.
func TestBrainstormAllowedPerChannel(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		Gold:      true,
		Dev:       true,
		Local:     true,
		RC:        true,
		Public:    true,
		Unknown:   false,
		"":        false,
		"Gold":    false,
		"nightly": false,
	}
	for channel, want := range cases {
		if got := BrainstormAllowed(channel); got != want {
			t.Errorf("BrainstormAllowed(%q) = %v, want %v", channel, got, want)
		}
	}
}

// The launcher's channel may narrow the gate, never widen it; an unknown name opens nothing. Must match
// build-channel.test.ts. The brainstorm is open on every channel but an unknown one (#2320).
func TestGateChannelNeverWidensARelease(t *testing.T) {
	t.Parallel()
	cases := []struct {
		dev     bool
		baked   string
		runtime string
		want    string
		allowed bool
	}{
		{false, Public, Gold, Public, true},
		{false, RC, Dev, RC, true},
		{false, Public, "anything", Public, true},
		{false, "nightly", "", Unknown, false},
		{false, Gold, "anything", Unknown, false},
		{false, Gold, "", Gold, true},
		{false, Local, "", Local, true},
		{false, "", "", Local, true},
		{false, Local, Gold, Gold, true},
		{false, Local, Dev, Dev, true},
		{false, Gold, Dev, Gold, true},
		{false, Gold, Local, Gold, true},
		{false, Gold, Public, Public, true},
		{false, Gold, RC, RC, true},
		{true, Public, "", Dev, true},
	}
	for _, c := range cases {
		got := GateChannel(c.dev, c.baked, c.runtime)
		if got != c.want || BrainstormAllowed(got) != c.allowed {
			t.Errorf("GateChannel(%v, %q, %q) = %q (allowed %v), want %q (allowed %v)",
				c.dev, c.baked, c.runtime, got, BrainstormAllowed(got), c.want, c.allowed)
		}
	}
}

// FR-BOSS-010 AC1 (#2320): the gate wavesrv's route and brief read follows the channel Electron main gave and nothing
// the developer stored in Features in test; wavesrv started without a channel, or on one it does not know, has none.
// It changes the gate channel by hand, so it is not parallel.
func TestBrainstormEnabledFollowsTheChannelAlone(t *testing.T) {
	stale := []Narrowing{{}, {Public: true}, {Off: []string{"brainstorm"}}, {Public: true, Off: []string{"brainstorm"}}}
	for channel, want := range map[string]bool{Dev: true, Local: true, Gold: true, RC: true, Public: true, Unknown: false, "": false} {
		for _, state := range stale {
			restore := StartAsForTest(channel, state)
			got := BrainstormEnabled()
			restore()
			if got != want {
				t.Errorf("BrainstormEnabled() on %q with %+v = %v, want %v", channel, state, got, want)
			}
		}
	}
	if BrainstormEnabled() {
		t.Error("a wavesrv started without a channel has the brainstorm")
	}
}

func TestWhatMainGaveIsReadOnceAndRemoved(t *testing.T) {
	t.Setenv(AppChannelEnv, Public)
	t.Setenv(AppDevEnv, "")
	t.Setenv(RuntimeChannelEnv, Gold)
	given, channel := takeFromEnv()
	if !given || channel != Public {
		t.Errorf("read %v %q, want a public build kept public", given, channel)
	}
	if _, left := os.LookupEnv(AppChannelEnv); left {
		t.Error("the channel stays in wavesrv's environment, for its terminals to hand on")
	}
	if given, channel := takeFromEnv(); given || channel != "" {
		t.Errorf("read again %v %q, want nothing", given, channel)
	}
}

// #2257: the developer's gold, as scripts/moltenterm-build-gold.sh bakes it (MOLTENTERM_BUILD_CHANNEL=gold) and Electron
// main hands it on for a packaged app (emain/moltenterm-build-channel.ts wavesrvChannelEnv(true, "gold")), launched
// without a launcher's channel: the brainstorm is open, so his brief carries its section.
func TestTheDevelopersGoldOpensTheBrainstorm(t *testing.T) {
	t.Setenv(AppChannelEnv, Gold)
	t.Setenv(AppDevEnv, "")
	t.Setenv(RuntimeChannelEnv, "")
	os.Unsetenv(RuntimeChannelEnv)
	given, channel := takeFromEnv()
	if !given || channel != Gold || !BrainstormAllowed(channel) {
		t.Errorf("read %v %q (allowed %v), want the gold with its brainstorm", given, channel, BrainstormAllowed(channel))
	}
}
