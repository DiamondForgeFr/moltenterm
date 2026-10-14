// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package panelmove

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A layout as the frontend saves it: a row of the editor and a column of two terminals.
const savedLayout = `{
	"oid": "layout1",
	"rootnode": {"id": "root", "flexDirection": "row", "size": 10, "children": [
		{"id": "n-editor", "size": 10, "data": {"blockId": "editor"}},
		{"id": "col", "flexDirection": "column", "size": 10, "children": [
			{"id": "n-term1", "size": 10, "data": {"blockId": "term1"}},
			{"id": "n-term2", "size": 10, "data": {"blockId": "term2"}}
		]}
	]},
	"focusednodeid": "n-term2",
	"leaforder": [{"nodeid": "n-editor", "blockid": "editor"}, {"nodeid": "n-term1", "blockid": "term1"}]
}`

func readLayout(t *testing.T) *waveobj.LayoutState {
	t.Helper()
	var layout waveobj.LayoutState
	if err := json.Unmarshal([]byte(savedLayout), &layout); err != nil {
		t.Fatal(err)
	}
	return &layout
}

func TestMainBlockIdIsTheFocusedPanel(t *testing.T) {
	if got := MainBlockId(readLayout(t), []string{"editor", "term1", "term2"}); got != "term2" {
		t.Fatalf("main panel: %q", got)
	}
}

func TestMainBlockIdFallsBackToTheLayoutOrder(t *testing.T) {
	layout := readLayout(t)
	layout.FocusedNodeId = ""
	if got := MainBlockId(layout, []string{"editor", "term1", "term2"}); got != "editor" {
		t.Fatalf("first in order: %q", got)
	}
	// A focused node whose block already left the tab is skipped.
	layout.FocusedNodeId = "n-term2"
	if got := MainBlockId(layout, []string{"term1"}); got != "term1" {
		t.Fatalf("only blocks of the tab: %q", got)
	}
}

func TestMainBlockIdWithoutOrder(t *testing.T) {
	layout := readLayout(t)
	layout.FocusedNodeId = ""
	layout.LeafOrder = nil
	if got := MainBlockId(layout, []string{"term1", "term2"}); got != "term1" {
		t.Fatalf("first leaf of the tree: %q", got)
	}
	if got := MainBlockId(nil, []string{"x"}); got != "x" {
		t.Fatalf("no layout: %q", got)
	}
	if got := MainBlockId(nil, nil); got != "" {
		t.Fatalf("an empty tab has no main panel: %q", got)
	}
}

func TestCheckRequest(t *testing.T) {
	if err := CheckRequest(MoveRequest{FromTabId: "a", ToTabId: "b"}); err != nil {
		t.Fatal(err)
	}
	if err := CheckRequest(MoveRequest{FromTabId: "a", ToTabId: "a"}); err == nil {
		t.Fatal("a tab onto itself is refused")
	}
	if err := CheckRequest(MoveRequest{FromTabId: "a"}); err == nil {
		t.Fatal("a move without its target tab is refused")
	}
}

func TestOnlyWindowsMovePanels(t *testing.T) {
	e := routetest.Make(t)
	moved := false
	link, err := localroute.MakeLink(e.Router, route(func(context.Context, MoveRequest) (MoveResult, error) {
		moved = true
		return MoveResult{}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	req := map[string]any{"fromtabid": "a", "totabid": "b"}
	routetest.MustRefuse(t, link, e.NonWindows(), MoveCommand, req)
	if moved {
		t.Fatal("a caller other than a window moved a panel")
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), "other", nil); errStr == "" {
		t.Fatal("unknown command answered")
	}
}
