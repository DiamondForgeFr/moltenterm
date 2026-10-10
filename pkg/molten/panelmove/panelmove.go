// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package panelmove moves a tab's main panel into another tab of the same workspace (drag to split, FR-SHELL-060):
// the panel keeps its block, so a terminal keeps its shell and its scrollback.
package panelmove

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	RouteId     = "molten:panelmove"
	MoveCommand = "moltenpanelmove"
	// The layout action a tab's renderer applies to drop a node whose block moved to another tab: the node leaves the
	// layout, the block is not deleted (Wave's "delete" closes the block). Handled in frontend/moltenterm-shell/split.
	LayoutActionDetach = "molten:detach"
)

// MoveRequest: the tab whose main panel moves (the dragged tab) and the tab it moves to (the one shown).
type MoveRequest struct {
	FromTabId string `json:"fromtabid"`
	ToTabId   string `json:"totabid"`
}

// MoveResult: the moved block, and whether the dragged tab is left without any panel (the window then closes it).
type MoveResult struct {
	BlockId     string `json:"blockid"`
	SourceEmpty bool   `json:"sourceempty,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
}

func CheckRequest(req MoveRequest) error {
	if req.FromTabId == "" || req.ToTabId == "" {
		return fmt.Errorf("a panel move needs the tab it leaves and the tab it goes to")
	}
	if req.FromTabId == req.ToTabId {
		return fmt.Errorf("the panel is already in this tab")
	}
	return nil
}

// MainBlockId is the tab's main panel: its focused panel, else the first in the layout's order, else the tab's first
// block. Only a block of the tab qualifies (a layout saved before a block left it may still name it).
func MainBlockId(layout *waveobj.LayoutState, tabBlockIds []string) string {
	inTab := map[string]bool{}
	for _, id := range tabBlockIds {
		inTab[id] = true
	}
	if layout != nil {
		if id := blockIdOfNode(layout.RootNode, layout.FocusedNodeId); id != "" && inTab[id] {
			return id
		}
		if layout.LeafOrder != nil {
			for _, leaf := range *layout.LeafOrder {
				if leaf.BlockId != "" && inTab[leaf.BlockId] {
					return leaf.BlockId
				}
			}
		}
		if id := firstLeafBlockId(layout.RootNode, inTab); id != "" {
			return id
		}
	}
	if len(tabBlockIds) > 0 {
		return tabBlockIds[0]
	}
	return ""
}

// The layout tree as the frontend persists it (frontend/layout/lib/types.ts LayoutNode): id, children, data.blockId.
func asNode(node any) (map[string]any, bool) {
	m, ok := node.(map[string]any)
	return m, ok
}

func nodeBlockId(m map[string]any) string {
	data, ok := m["data"].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := data["blockId"].(string)
	return id
}

func nodeChildren(m map[string]any) []any {
	children, _ := m["children"].([]any)
	return children
}

func blockIdOfNode(node any, nodeId string) string {
	if nodeId == "" {
		return ""
	}
	m, ok := asNode(node)
	if !ok {
		return ""
	}
	if id, _ := m["id"].(string); id == nodeId {
		return nodeBlockId(m)
	}
	for _, child := range nodeChildren(m) {
		if id := blockIdOfNode(child, nodeId); id != "" {
			return id
		}
	}
	return ""
}

func firstLeafBlockId(node any, inTab map[string]bool) string {
	m, ok := asNode(node)
	if !ok {
		return ""
	}
	if id := nodeBlockId(m); id != "" && inTab[id] {
		return id
	}
	for _, child := range nodeChildren(m) {
		if id := firstLeafBlockId(child, inTab); id != "" {
			return id
		}
	}
	return ""
}
