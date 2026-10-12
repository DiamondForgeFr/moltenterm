// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The layout tree as the frontend persists it in LayoutState.RootNode (frontend/layout/lib/types.ts LayoutNode): id,
// flexDirection ("row" puts children side by side), size, children, data.blockId.

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

func nodeSize(m map[string]any) *uint {
	f, ok := m["size"].(float64)
	if !ok || f <= 0 {
		return nil
	}
	size := uint(f)
	return &size
}

func firstLeaf(node any) string {
	m, ok := asNode(node)
	if !ok {
		return ""
	}
	if children := nodeChildren(m); len(children) > 0 {
		return firstLeaf(children[0])
	}
	return nodeBlockId(m)
}

func isLeaf(node any) bool {
	m, ok := asNode(node)
	return ok && len(nodeChildren(m)) == 0 && nodeBlockId(m) != ""
}

// findParent returns the node holding the block's leaf, the path to that node from the root, and the leaf's index
// in it.
func findParent(node any, blockId string, path []int) (map[string]any, []int, int) {
	m, ok := asNode(node)
	if !ok {
		return nil, nil, -1
	}
	for i, child := range nodeChildren(m) {
		if cm, ok := asNode(child); ok && len(nodeChildren(cm)) == 0 && nodeBlockId(cm) == blockId {
			return m, path, i
		}
		if p, ppath, idx := findParent(child, blockId, append(append([]int{}, path...), i)); p != nil {
			return p, ppath, idx
		}
	}
	return nil, nil, -1
}

// PanePlacement is where a closed pane goes back. Beside a sibling that is a single panel, on the same side, when it
// has one: the split puts it back in place even when its split folded away meanwhile. Between split siblings, at its
// index in its split (IndexArr, for an insertatindex action, which inserts after the index it is given). First in
// its split before a split sibling, beside that split's first panel (the nearest spot). A pane alone in its tab has
// no neighbour: it goes where Wave puts a new block.
func PanePlacement(root any, blockId string) (molten.PanePlacement, []int) {
	parent, path, idx := findParent(root, blockId, nil)
	if parent == nil {
		return molten.PanePlacement{}, nil
	}
	children := nodeChildren(parent)
	row := parent["flexDirection"] != "column"
	after, before := "down", "up"
	if row {
		after, before = "right", "left"
	}
	if idx > 0 && isLeaf(children[idx-1]) {
		return molten.PanePlacement{TargetBlockId: firstLeaf(children[idx-1]), Split: after}, nil
	}
	if idx+1 < len(children) && isLeaf(children[idx+1]) {
		return molten.PanePlacement{TargetBlockId: firstLeaf(children[idx+1]), Split: before}, nil
	}
	if idx > 0 {
		return molten.PanePlacement{}, append(append([]int{}, path...), idx-1)
	}
	if idx+1 < len(children) {
		return molten.PanePlacement{TargetBlockId: firstLeaf(children[idx+1]), Split: before}, nil
	}
	return molten.PanePlacement{}, nil
}
