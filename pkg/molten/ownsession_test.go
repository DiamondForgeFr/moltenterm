// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestIsOwnSessionReadsTheMarkOfABlockOrATab(t *testing.T) {
	if !IsOwnSession(waveobj.MetaMapType{OwnSessionMetaKey: true}) {
		t.Error("a block or a tab with the mark is Brokk's")
	}
	for _, meta := range []waveobj.MetaMapType{nil, {}, {OwnSessionMetaKey: false}, {OwnSessionMetaKey: "true"}, {"molten:other": true}} {
		if IsOwnSession(meta) {
			t.Errorf("%v is not Brokk's", meta)
		}
	}
}

// FR-BOSS-009, AC26 (#2033): his tab never stays among the views. The developer may be shown it on purpose (Open his
// terminal), which reveals it like any hidden tab; once he leaves it, it is hidden again.
func TestHideLeftOwnTabHidesItAgainOnceTheDeveloperLeavesIt(t *testing.T) {
	ws := hiddenWs([]string{"a", "brokk", "c"}, nil)
	own := waveobj.MetaMapType{OwnSessionMetaKey: true}
	if !HideLeftOwnTab(ws, "brokk", own, "a") || !slices.Equal(HiddenTabIds(ws), []string{"brokk"}) {
		t.Fatalf("hidden after leaving: %v, want his tab", HiddenTabIds(ws))
	}
	if HideLeftOwnTab(ws, "brokk", own, "c") {
		t.Error("a tab that is hidden already changes nothing")
	}
}

func TestHideLeftOwnTabLeavesTheOtherTabsAlone(t *testing.T) {
	own := waveobj.MetaMapType{OwnSessionMetaKey: true}
	ws := hiddenWs([]string{"a", "brokk"}, []any{"x-gone"})
	if HideLeftOwnTab(ws, "a", waveobj.MetaMapType{}, "brokk") {
		t.Error("a tab the developer's agents use is a view like any other")
	}
	if HideLeftOwnTab(ws, "brokk", own, "brokk") {
		t.Error("staying in his tab hides nothing")
	}
	if HideLeftOwnTab(ws, "", own, "a") || HideLeftOwnTab(ws, "gone", own, "a") || HideLeftOwnTab(nil, "brokk", own, "a") {
		t.Error("no tab, a tab the workspace no longer holds, or no workspace changes nothing")
	}
	if len(HiddenTabIds(ws)) != 0 {
		t.Errorf("hidden %v, want none", HiddenTabIds(ws))
	}
}

// What the window did to keep other hidden tabs is kept.
func TestHideLeftOwnTabKeepsTheTabsAlreadyHidden(t *testing.T) {
	ws := hiddenWs([]string{"a", "b", "brokk"}, []any{"b"})
	if !HideLeftOwnTab(ws, "brokk", waveobj.MetaMapType{OwnSessionMetaKey: true}, "a") {
		t.Fatal("his tab is hidden again")
	}
	if got := HiddenTabIds(ws); !slices.Equal(got, []string{"b", "brokk"}) {
		t.Errorf("hidden %v, want b kept and his tab added", got)
	}
}
