// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import "testing"

// FR-BOSS-012 AC1 (#2336): the log watch is the registry's feature on gold, dev and local builds.
func TestTheLogWatchIsInTheRegistryForInternalBuilds(t *testing.T) {
	t.Parallel()
	feature, ok := FeatureById(FeatureLogWatch)
	if !ok || feature.Ticket != 2336 {
		t.Fatalf("the log watch is not in the registry: %+v", feature)
	}
	want := map[string]bool{Dev: true, Local: true, Gold: true}
	for _, channel := range everyChannel {
		if got := LogWatchAllowed(channel, Narrowing{}); got != want[channel] {
			t.Errorf("LogWatchAllowed(%q) = %v, want %v", channel, got, want[channel])
		}
		if InternalChannel(channel) != want[channel] {
			t.Errorf("InternalChannel(%q) = %v", channel, InternalChannel(channel))
		}
	}
	for _, state := range []Narrowing{{Public: true}, {Off: []string{FeatureLogWatch}}} {
		if LogWatchAllowed(Gold, state) {
			t.Errorf("the developer's switch %+v left the log watch on", state)
		}
	}
}

// A registry that listed rc and public by mistake still cannot open the log watch on a release: the internal-only lock
// holds on its own, in Go as in the window (gated-features.test.ts).
func TestTheLogWatchNeverOpensOnAReleaseWhateverTheRegistrySays(t *testing.T) {
	before := registry
	registry = []Feature{{Id: FeatureLogWatch, LabelKey: "a", DescriptionKey: "b", Channels: []string{Dev, Local, Gold, RC, Public}, Ticket: 2336}}
	t.Cleanup(func() { registry = before })
	for _, channel := range []string{RC, Public, Unknown, ""} {
		if !FeatureAllowed(FeatureLogWatch, RC) {
			t.Fatal("the test registry does not open rc")
		}
		if LogWatchAllowed(channel, Narrowing{}) {
			t.Errorf("the log watch opened on %q", channel)
		}
		restore := StartAsForTest(channel, Narrowing{})
		if LogWatchEnabled() {
			t.Errorf("LogWatchEnabled on %q", channel)
		}
		restore()
	}
	restore := StartAsForTest(Gold, Narrowing{})
	defer restore()
	if !LogWatchEnabled() {
		t.Error("a gold with nothing switched off has no log watch")
	}
}
