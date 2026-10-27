// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
)

// The setup's agent board on the route (FR-MC-045, #1163): the agent's commands come from a local terminal and reach
// only the setup of the project its own tab sets up; the panel's commands come from a window only.

const setupBoardDraft = `{
  "schema": 1,
  "name": "fixture",
  "release": {
    "rc": [
      {"id": "tag", "title": "Tag the candidate", "phase": "cut", "run": "molten release tag {tag}"}
    ]
  }
}
`

const setupBoardAdd = `{"op": "add", "channel": "rc", "before": "tag", "step": {"id": "lint", "title": "Lint", "phase": "cut", "run": "npm run lint"}}`

func setupBoardLink(t *testing.T, scopes map[string]string) (*localroute.Link, *routetest.Env, *pipelinesetup.Board) {
	t.Helper()
	e := routetest.Make(t)
	board := pipelinesetup.MakeBoard(nil)
	l := &routeLink{board: &SetupBoardRoute{Board: board, Scope: func(_ context.Context, blockId string) (string, string, error) {
		return scopes[blockId], "Olivia", nil
	}}}
	link, err := localroute.MakeLink(e.Router, l.route())
	if err != nil {
		t.Fatal(err)
	}
	return link, e, board
}

func TestSetupBoardCommandsByCaller(t *testing.T) {
	dir := t.TempDir()
	link, e, board := setupBoardLink(t, map[string]string{routetest.TerminalBlock: dir})
	agentRefusal := "the pipeline setup's agent commands run in the terminal of the project's pipeline tab"
	propose := map[string]any{"change": setupBoardAdd, "why": "lint avant le tag"}
	routetest.MustRefuseWith(t, link, append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...), SetupAgentProposeCommand, propose, agentRefusal)
	routetest.MustRefuseWith(t, link, append([]routetest.From{e.Terminal(), e.Electron()}, e.Forged()...), SetupBoardOpenCommand, map[string]any{"dir": dir}, "is answered to")
	routetest.MustRefuseWith(t, link, []routetest.From{e.Terminal()}, SetupBoardDecideCommand, map[string]any{"dir": dir, "key": "1", "accept": true}, "is answered to")
	routetest.MustRefuseWith(t, link, []routetest.From{e.Terminal()}, SetupBoardApplyCommand, map[string]any{"dir": dir, "text": setupBoardDraft}, "is answered to")

	if _, errStr := routetest.Ask(t, link, e.Terminal(), SetupAgentShowCommand, nil); !strings.Contains(errStr, "notopen") {
		t.Fatalf("show with no setup open: %q", errStr)
	}
	steps := []map[string]any{{"channel": "rc", "n": 1, "ids": []string{"tag"}, "text": "Marque la candidate"}}
	if _, errStr := routetest.Ask(t, link, e.Window(), SetupBoardOpenCommand, map[string]any{"dir": dir, "screen": "understand", "text": setupBoardDraft, "steps": steps}); errStr != "" {
		t.Fatal(errStr)
	}
	// The change JSON is sent as the object, the way `molten pipeline setup propose` sends it.
	propose["change"] = map[string]any{"op": "add", "channel": "rc", "before": "tag", "step": map[string]any{"id": "lint", "title": "Lint", "phase": "cut", "run": "npm run lint"}}
	data, errStr := routetest.Ask(t, link, e.Terminal(), SetupAgentProposeCommand, propose)
	if errStr != "" || !strings.Contains(toJsonText(t, data), `"by":"Olivia"`) {
		t.Fatalf("propose: %v %q", data, errStr)
	}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), SetupAgentExplainCommand, map[string]any{"step": "rc/1", "note": "ici"}); errStr != "" {
		t.Fatal(errStr)
	}
	state, _ := board.State(dir)
	if len(state.Items) != 1 || state.Items[0].By != "Olivia" || state.Explain == nil || state.Marks["rc/lint"].Op != pipelinesetup.BoardMarkAdd {
		t.Fatalf("the board %+v", state)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), SetupBoardDecideCommand, map[string]any{"dir": dir, "key": "1", "accept": true}); errStr != "" {
		t.Fatal(errStr)
	}
	applied, errStr := routetest.Ask(t, link, e.Window(), SetupBoardApplyCommand, map[string]any{"dir": dir, "text": setupBoardDraft})
	var answer pipelinesetup.BoardApplyAnswer
	if err := json.Unmarshal([]byte(toJsonText(t, applied)), &answer); err != nil {
		t.Fatal(err)
	}
	if errStr != "" || !strings.Contains(answer.Proposed, `"lint"`) || len(answer.Applied) != 1 {
		t.Fatalf("apply: %v %q", applied, errStr)
	}
}

func TestSetupBoardAgentReachesOnlyItsOwnTabsProject(t *testing.T) {
	dir := t.TempDir()
	link, e, board := setupBoardLink(t, map[string]string{})
	if _, errStr := routetest.Ask(t, link, e.Window(), SetupBoardOpenCommand, map[string]any{"dir": dir, "screen": "understand", "text": setupBoardDraft}); errStr != "" {
		t.Fatal(errStr)
	}
	for _, command := range []string{SetupAgentShowCommand, SetupAgentProposeCommand, SetupAgentFlagCommand} {
		if _, errStr := routetest.Ask(t, link, e.Terminal(), command, map[string]any{"point": "x", "change": setupBoardAdd, "why": "x"}); !strings.Contains(errStr, "not in a pipeline setup tab") {
			t.Fatalf("%s from a terminal outside a pipeline tab: %q", command, errStr)
		}
	}
	if state, _ := board.State(dir); len(state.Items) != 0 {
		t.Fatalf("a terminal of another tab changed the setup: %+v", state.Items)
	}
}

func toJsonText(t *testing.T, data any) string {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
