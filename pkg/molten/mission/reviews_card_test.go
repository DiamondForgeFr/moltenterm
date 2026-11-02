// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// #1130: a PR's notification names it by its card's number, the PR number after it only when the two differ.
func TestPrCard(t *testing.T) {
	ticketed := MakePrCard(1120, 1107)
	if ticketed.Number() != "1107" || ticketed.English() != "#1107 (PR #1120)" {
		t.Fatalf("with a ticket: %+v %s", ticketed, ticketed.English())
	}
	text := ticketed.Aside(uimsg.Make("notif.review.ciGreenTitle", "number", ticketed.Number()))
	if text.Parts["pr"] == nil || text.Parts["pr"].Code != "notif.review.prAside" || text.Parts["pr"].Vars["number"] != "1120" {
		t.Fatalf("with a ticket: %+v", text)
	}
	for _, plain := range []PrCard{MakePrCard(1120, 0), MakePrCard(1120, 1120)} {
		text := plain.Aside(uimsg.Make("notif.review.ciGreenTitle", "number", plain.Number()))
		if plain.Number() != "1120" || plain.English() != "#1120" || text.Parts != nil || text.Vars["pr"] != "" {
			t.Fatalf("no other ticket: %+v %+v", plain, text)
		}
		if _, ok := text.Vars["pr"]; !ok {
			t.Fatalf("{pr} is filled, empty: %+v", text)
		}
	}
	action := ticketed.Action("/p/app")
	if action.Id != ReviewsCardActionId || action.Gesture != ReviewsCardGesture || action.Args["dir"] != "/p/app" || action.Args["number"] != 1120 {
		t.Fatalf("the action opens the PR's card: %+v", action)
	}
}
