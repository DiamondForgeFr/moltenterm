// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"os"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// A remote host never reads or clears this machine's task memory, a forged tab source included, and a local terminal
// reads its own workspace's only (#662).
func TestRouteRefusesForwardedCallers(t *testing.T) {
	s, _ := makeTestStore(t)
	if _, err := s.Update("ws-1", OwnerUser, setGoal("keep this goal", OwnerUser)); err != nil {
		t.Fatal(err)
	}
	path, _ := s.Path("ws-1")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: s}).route())
	if err != nil {
		t.Fatal(err)
	}
	req := map[string]any{"workspaceid": "ws-1", "create": true}
	for _, command := range []string{molten.TaskReadCommand, molten.TaskHistoryCommand, molten.TaskRestoreCommand, molten.TaskClearCommand} {
		routetest.MustRefuse(t, link, e.NonLocal(), command, req)
		other := map[string]any{"blockid": "block-other", "workspaceid": "ws-1"}
		if _, errStr := routetest.Ask(t, link, e.Terminal(), command, other); !strings.Contains(errStr, "its own workspace") {
			t.Errorf("%s for another terminal's block: %q", command, errStr)
		}
	}
	if after, err := os.ReadFile(path); err != nil || string(after) != string(before) {
		t.Fatalf("refused caller changed the checkpoint: %v", err)
	}
}
