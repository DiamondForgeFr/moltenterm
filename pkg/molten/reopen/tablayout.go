// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

// A closed tab comes back by splits, the way its panes were made: the first pane fills the tab, then, level by
// level, each split's panes are placed beside its first one, on the split's side, before each of them is split in
// turn the other way. Wave's split puts a pane beside its target in the target's own split when the sides agree,
// and makes a new split in the target's place when they cross, so this gives the same tree back. Sizes are not kept:
// a split shares its room evenly.

type tabBuilder struct {
	leaves  []Leaf
	focused string
	meta    func(blockId string) (map[string]any, bool)
}

func firstLeafNode(node any) map[string]any {
	m, ok := asNode(node)
	if !ok {
		return nil
	}
	if children := nodeChildren(m); len(children) > 0 {
		return firstLeafNode(children[0])
	}
	return m
}

// add puts a pane in the list beside target (-1: it fills the tab); it returns its index, or target when the pane's
// block is gone (its place is then left to the panes around it).
func (b *tabBuilder) add(leaf map[string]any, target int, split string) int {
	if leaf == nil {
		return target
	}
	meta, ok := b.meta(nodeBlockId(leaf))
	if !ok {
		return target
	}
	if target < 0 && len(b.leaves) > 0 {
		target = len(b.leaves) - 1
		if split == "" {
			split = "right"
		}
	}
	id, _ := leaf["id"].(string)
	b.leaves = append(b.leaves, Leaf{Meta: meta, Target: target, Split: split, Focused: b.focused != "" && id == b.focused})
	return len(b.leaves) - 1
}

// expand places the panes of a split whose first pane is already at anchor, then expands each of its children.
func (b *tabBuilder) expand(m map[string]any, anchor int) {
	children := nodeChildren(m)
	if len(children) == 0 {
		return
	}
	side := "right"
	if m["flexDirection"] == "column" {
		side = "down"
	}
	reps := make([]int, len(children))
	reps[0] = anchor
	prev := anchor
	for i := 1; i < len(children); i++ {
		prev = b.add(firstLeafNode(children[i]), prev, side)
		reps[i] = prev
	}
	for i, child := range children {
		if cm, ok := asNode(child); ok && len(nodeChildren(cm)) > 0 {
			b.expand(cm, reps[i])
		}
	}
}

// LayoutLeaves lists a tab's panes in the order they come back. meta gives each block's meta; a block without one
// (gone meanwhile) is left out.
func LayoutLeaves(root any, focusedNodeId string, meta func(blockId string) (map[string]any, bool)) []Leaf {
	m, ok := asNode(root)
	if !ok {
		return nil
	}
	b := &tabBuilder{focused: focusedNodeId, meta: meta}
	first := b.add(firstLeafNode(m), -1, "")
	b.expand(m, first)
	return b.leaves
}
