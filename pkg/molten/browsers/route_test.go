// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browsers

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: a remote host forging a tab source no longer changes the per-site choices; `molten open` still works from
// anywhere.
func TestRouteSitesFromWindowsOnly(t *testing.T) {
	e := routetest.Make(t)
	saved := 0
	opener := MakeOpener(func() Settings { return Settings{} }, func(map[string]string) error {
		saved++
		return nil
	})
	link, err := localroute.MakeLink(e.Router, route(opener))
	if err != nil {
		t.Fatal(err)
	}
	site := map[string]any{"site": "example.com", "engine": "installed"}
	routetest.MustRefuseWith(t, link, e.NonWindows(), SiteCommand, site, "from a MoltenTerm window")
	routetest.MustRefuse(t, link, e.NonWindows(), ActivateCommand, map[string]any{"url": "https://example.com"})
	if saved != 0 {
		t.Fatalf("a refused caller saved %d per-site choices", saved)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), SiteCommand, site); errStr != "" || saved != 1 {
		t.Fatalf("the window's choice: %q (saved %d)", errStr, saved)
	}
	for _, from := range append([]routetest.From{e.Terminal()}, e.Forged()...) {
		if _, errStr := routetest.Ask(t, link, from, ListCommand, nil); errStr != "" {
			t.Errorf("the list from %s: %s", from.Name, errStr)
		}
	}
}
