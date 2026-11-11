// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import (
	"os"
	"testing"
)

// FR-BOSS-010 AC1 (#2246): gold, dev and local builds only; a release candidate, a public release, an unknown channel
// and no channel at all are refused.
func TestBrainstormAllowedPerChannel(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		Gold:      true,
		Dev:       true,
		Local:     true,
		RC:        false,
		Public:    false,
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
// build-channel.test.ts.
func TestGateChannelNeverWidensARelease(t *testing.T) {
	t.Parallel()
	cases := []struct {
		dev     bool
		baked   string
		runtime string
		want    string
		allowed bool
	}{
		{false, Public, Gold, Public, false},
		{false, RC, Dev, RC, false},
		{false, Public, "anything", Public, false},
		{false, "nightly", "", Unknown, false},
		{false, Gold, "anything", Unknown, false},
		{false, Gold, "", Gold, true},
		{false, Local, "", Local, true},
		{false, "", "", Local, true},
		{false, Local, Gold, Gold, true},
		{false, Local, Dev, Dev, true},
		{false, Gold, Dev, Gold, true},
		{false, Gold, Local, Gold, true},
		{false, Gold, Public, Public, false},
		{false, Gold, RC, RC, false},
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
