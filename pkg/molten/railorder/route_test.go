// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: the rail answers the windows and `molten rail group` in a local terminal; a remote host, a forged tab source
// included, changes nothing.
func TestRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	applied := 0
	store := Store{
		Read: func(context.Context) (Rail, error) { return Rail{}, nil },
		Apply: func(_ context.Context, change func(Rail) (Rail, error)) (Rail, error) {
			applied++
			return Rail{}, nil
		},
	}
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: store}).route())
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{MoveCommand, JoinCommand, LeaveCommand, RenameCommand, UngroupCommand, ListCommand} {
		routetest.MustRefuse(t, link, e.NonLocal(), command, map[string]any{})
	}
	if applied != 0 {
		t.Fatalf("a refused caller changed the rail %d times", applied)
	}
	for _, from := range []routetest.From{e.Window(), e.Terminal()} {
		if _, errStr := routetest.Ask(t, link, from, ListCommand, nil); errStr != "" {
			t.Errorf("the list for %s: %s", from.Name, errStr)
		}
	}
}
