// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import "testing"

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

func TestBrainstormEnabledReadsTheChannelMainGave(t *testing.T) {
	t.Setenv(Env, Public)
	if BrainstormEnabled() {
		t.Error("enabled on a public release")
	}
	t.Setenv(Env, Gold)
	if !BrainstormEnabled() {
		t.Error("not enabled on a gold")
	}
	t.Setenv(Env, "")
	if BrainstormEnabled() {
		t.Error("enabled with no channel")
	}
}
