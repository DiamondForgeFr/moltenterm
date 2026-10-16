// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// #662: only a window or Electron main answers a handoff request (an agent cannot approve its own send), even when a
// remote host forges a tab source on its connection; lists and sends come from a local terminal's own link.
func TestRouteCallers(t *testing.T) {
	m, _, _, _ := makeFixture(t)
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{manager: m}).route())
	if err != nil {
		t.Fatal(err)
	}
	answer := map[string]any{"requestid": "r1", "decision": DecisionAlways}
	routetest.MustRefuse(t, link, append([]routetest.From{e.Terminal()}, e.Forged()...), AnswerCommand, answer)
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notTerminals, ListCommand, map[string]any{"token": "t"}, errRemote)
	routetest.MustRefuseWith(t, link, notTerminals, SendCommand, map[string]any{"token": "t", "to": "Jérôme"}, errRemote)
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		if _, errStr := routetest.Ask(t, link, from, AnswerCommand, answer); !strings.Contains(errStr, "no longer waiting") {
			t.Errorf("the answer from %s reached the manager: %q", from.Name, errStr)
		}
	}
	// A window words the refusal by its code (#656).
	_, errStr := routetest.Ask(t, link, e.Window(), AnswerCommand, answer)
	if text, _ := uimsg.Unwire(errStr); text == nil || text.Code != "handoff.notwaiting" {
		t.Errorf("the window got no code: %q", errStr)
	}
}
