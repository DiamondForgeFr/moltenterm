// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #662: the first run, a step's own commands included (#1667's install), answers windows only; a remote host forging a tab source does
// not get through.
func TestRouteAnswersWindowsOnly(t *testing.T) {
	const command = "onboardingtestprobe"
	var sources []string
	if err := HandleCommand(command, func(_ context.Context, source string, _ any) (any, error) {
		sources = append(sources, source)
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, firstRunRoute)
	if err != nil {
		t.Fatal(err)
	}
	// #1667: an agent in a terminal cannot start, answer or cancel an install.
	refused := []string{command, UpdateCommand, StateCommand, PanelCommand, CliInstallCommand, CliInstallStatusCommand,
		CliInstallInputCommand, CliInstallCancelCommand}
	for _, c := range refused {
		routetest.MustRefuse(t, link, e.NonWindows(), c, map[string]any{})
	}
	if len(sources) != 0 {
		t.Fatalf("refused callers reached a step: %v", sources)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), command, nil); errStr != "" || len(sources) != 1 || sources[0] != e.Window().Source {
		t.Fatalf("the window's call: %q %v", errStr, sources)
	}
}
