// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// DS-REV-011: only a window starts, ends or selects; a terminal (where an agent runs) may only read; a remote host,
// forging a window's source or not, gets nothing (#662); the MCP hello comes from a local terminal only.
func TestRouteSources(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{manager: MakeManager(Env{})}).route())
	if err != nil {
		t.Fatal(err)
	}
	start := map[string]any{"repo": "o/r", "number": 1}
	for _, command := range []string{mcpreview.StartCommand, mcpreview.EndCommand, mcpreview.SelectionCommand, mcpreview.SetHeadCommand,
		mcpreview.BriefCommand, mcpreview.AskCommand, mcpreview.AskCancelCommand} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, start)
	}
	for _, command := range []string{mcpreview.ListCommand, mcpreview.GetCommand, mcpreview.PostsCommand} {
		routetest.MustRefuse(t, link, e.NonLocal(), command, start)
	}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), mcpreview.ListCommand, nil); errStr != "" {
		t.Errorf("list from a local terminal: %s", errStr)
	}
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	for _, command := range []string{mcpreview.HelloCommand, mcpreview.CallCommand, mcpreview.ByeCommand} {
		routetest.MustRefuseWith(t, link, notTerminals, command, map[string]any{"token": "t", "sessiontoken": "s"}, mcpreview.ErrNotInMoltenTerm)
	}
	// A window's start is checked as a request: a bad one is refused before anything runs.
	if _, errStr := routetest.Ask(t, link, e.Window(), mcpreview.StartCommand, start); !strings.Contains(errStr, "projectdir") {
		t.Errorf("start from a window: %q", errStr)
	}
}
