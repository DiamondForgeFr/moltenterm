// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"fmt"
	"unicode/utf8"
)

// The graph is living (FR-BOSS-010 AC26, AC27, DS-BOSS-009, #2247): Brokk corrects what the talk made obsolete, and the
// developer edits the graph by hand, with the same operations and the same rules.
//
// - edit {id, text} rewrites a node's text in place;
// - remove {id, reason} removes a node with its links, and ties its children to its parent, so nothing else goes;
// - unlink {a, b} removes a cross-link (the rope to a parent goes only with its node);
// - retype {id, kind} gives a node another kind of an `add`;
// - merge {ids, into} folds near-duplicates into one node, which takes their children and their cross-links.
//
// None of them takes the centre (only `centre` changes it) or a reference node, MoltenTerm's own. Each change comes
// with what puts it back, for the history and the developer's Undo.

// The operations the developer makes by hand from a plate's menu (AC27); merge is Brokk's.
var developerOps = map[string]bool{
	OpEdit:   true,
	OpRetype: true,
	OpRemove: true,
	OpLink:   true,
	OpUnlink: true,
}

// PatchNode is a node as it was, and its place in the list then.
type PatchNode struct {
	Index int  `json:"index"`
	Node  Node `json:"node"`
}

// Patch puts the graph back as it was before one change: the nodes it changed or removed, as they were; the nodes it
// added, to take away; the links it removed, to put back; the links it added, to take away.
type Patch struct {
	Nodes      []PatchNode `json:"nodes,omitempty"`
	Added      []string    `json:"added,omitempty"`
	Links      []Link      `json:"links,omitempty"`
	LinksAdded []Link      `json:"linksadded,omitempty"`
}

// Change is one operation that changed the graph, and what puts it back.
type Change struct {
	Op   Op
	Undo Patch
}

// cleanOp is the operation as the history keeps it: its texts plain.
func cleanOp(op Op) Op {
	op.Text = CleanText(op.Text)
	op.Why = CleanText(op.Why)
	op.Reason = CleanText(op.Reason)
	op.Title = CleanText(op.Title)
	if op.Ids != nil {
		op.Ids = append([]string{}, op.Ids...)
	}
	// A conclusion's brief is brief.json's (#2250): the history keeps the plate alone.
	op.Brief = nil
	return op
}

func indexOf(g Graph) map[string]int {
	index := make(map[string]int, len(g.Nodes))
	for i, n := range g.Nodes {
		index[n.Id] = i
	}
	return index
}

func sameLink(l Link, a string, b string) bool {
	return (l.A == a && l.B == b) || (l.A == b && l.B == a)
}

// checkLivingOp checks the shape of edit, remove, unlink, retype and merge.
func checkLivingOp(op Op, what string) error {
	switch op.Op {
	case OpEdit:
		if err := checkId(op.Id, what); err != nil {
			return err
		}
		_, err := checkText(op.Text, what)
		return err
	case OpRemove:
		if err := checkId(op.Id, what); err != nil {
			return err
		}
		if utf8.RuneCountInString(CleanText(op.Reason)) > MaxText {
			return fmt.Errorf("%s: reason over %d characters", what, MaxText)
		}
		return nil
	case OpUnlink:
		if err := checkId(op.A, what); err != nil {
			return err
		}
		if err := checkId(op.B, what); err != nil {
			return err
		}
		if op.A == op.B {
			return fmt.Errorf("%s: a node linked to itself", what)
		}
		return nil
	case OpRetype:
		if err := checkId(op.Id, what); err != nil {
			return err
		}
		if !addKinds[op.Kind] {
			return fmt.Errorf("%s: unknown kind", what)
		}
		return nil
	case OpMerge:
		if len(op.Ids) == 0 || len(op.Ids) > MaxOps {
			return fmt.Errorf("%s: %d nodes to fold, want 1 to %d", what, len(op.Ids), MaxOps)
		}
		if err := checkId(op.Into, what+" into"); err != nil {
			return err
		}
		seen := make(map[string]bool, len(op.Ids))
		for _, id := range op.Ids {
			if err := checkId(id, what); err != nil {
				return err
			}
			if seen[id] || id == op.Into {
				return fmt.Errorf("%s: a node named twice", what)
			}
			seen[id] = true
		}
		return nil
	}
	return fmt.Errorf("%s: unknown operation", what)
}

// editable: a node an operation of the living graph may take: it exists, and it is neither the centre (unless the
// operation may keep it, an edit) nor a reference.
func editable(g Graph, index map[string]int, id string, centreToo bool, what string) (int, error) {
	at, ok := index[id]
	if !ok {
		return 0, fmt.Errorf("%s: unknown node", what)
	}
	if id == g.Centre && !centreToo {
		return 0, fmt.Errorf("%s: the centre stays", what)
	}
	if g.Nodes[at].Kind == KindReference {
		return 0, fmt.Errorf("%s: a reference node stays", what)
	}
	return at, nil
}

// applyLiving applies one of edit, remove, unlink, retype and merge to g. changed is false when the operation found
// the graph already as it asks (a text unchanged, a link already gone): nothing to keep in the history.
func applyLiving(g *Graph, op Op, what string) (Change, bool, error) {
	index := indexOf(*g)
	switch op.Op {
	case OpEdit:
		at, err := editable(*g, index, op.Id, true, what)
		if err != nil {
			return Change{}, false, err
		}
		text, _ := checkText(op.Text, what)
		if g.Nodes[at].Text == text {
			return Change{}, false, nil
		}
		was := PatchNode{Index: at, Node: g.Nodes[at]}
		g.Nodes[at].Text = text
		return Change{Op: cleanOp(op), Undo: Patch{Nodes: []PatchNode{was}}}, true, nil
	case OpRetype:
		at, err := editable(*g, index, op.Id, false, what)
		if err != nil {
			return Change{}, false, err
		}
		if g.Nodes[at].Kind == op.Kind {
			return Change{}, false, nil
		}
		was := PatchNode{Index: at, Node: g.Nodes[at]}
		g.Nodes[at].Kind = op.Kind
		// A proposal made another kind no longer offers anything (#2250).
		if g.Nodes[at].Action != "" {
			g.Nodes[at].Action = ""
			g.Nodes[at].Status = StatusOpen
		}
		return Change{Op: cleanOp(op), Undo: Patch{Nodes: []PatchNode{was}}}, true, nil
	case OpRemove:
		return removeNode(g, index, op, what)
	case OpUnlink:
		if _, ok := index[op.A]; !ok {
			return Change{}, false, fmt.Errorf("%s: unknown node", what)
		}
		if _, ok := index[op.B]; !ok {
			return Change{}, false, fmt.Errorf("%s: unknown node", what)
		}
		var removed []Link
		kept := make([]Link, 0, len(g.Links))
		for _, l := range g.Links {
			if sameLink(l, op.A, op.B) {
				removed = append(removed, l)
				continue
			}
			kept = append(kept, l)
		}
		if len(removed) == 0 {
			return Change{}, false, nil
		}
		g.Links = kept
		return Change{Op: cleanOp(op), Undo: Patch{Links: removed}}, true, nil
	case OpMerge:
		return mergeNodes(g, index, op, what)
	}
	return Change{}, false, fmt.Errorf("%s: unknown operation", what)
}

// removeNode takes a node away with its links; its children are tied to its parent.
func removeNode(g *Graph, index map[string]int, op Op, what string) (Change, bool, error) {
	at, err := editable(*g, index, op.Id, false, what)
	if err != nil {
		return Change{}, false, err
	}
	gone := g.Nodes[at]
	patch := Patch{Nodes: []PatchNode{{Index: at, Node: gone}}}
	nodes := make([]Node, 0, len(g.Nodes)-1)
	for i, n := range g.Nodes {
		if i == at {
			continue
		}
		if n.From == gone.Id {
			patch.Nodes = append(patch.Nodes, PatchNode{Index: i, Node: n})
			n.From = gone.From
		}
		nodes = append(nodes, n)
	}
	links := make([]Link, 0, len(g.Links))
	for _, l := range g.Links {
		if l.A == gone.Id || l.B == gone.Id {
			patch.Links = append(patch.Links, l)
			continue
		}
		links = append(links, l)
	}
	g.Nodes = nodes
	g.Links = links
	return Change{Op: cleanOp(op), Undo: patch}, true, nil
}

// mergeNodes folds op.Ids into op.Into. Into keeps its place and its text. A child of a folded node goes under Into,
// unless it is Into or one of Into's ancestors: that one goes under the nearest ancestor that stays, so the graph stays
// a tree. A cross-link of a folded node moves to Into; one that would tie Into to itself, or tie two nodes twice, goes.
func mergeNodes(g *Graph, index map[string]int, op Op, what string) (Change, bool, error) {
	if _, err := editable(*g, index, op.Into, true, what+" into"); err != nil {
		return Change{}, false, err
	}
	folded := make(map[string]bool, len(op.Ids))
	for _, id := range op.Ids {
		if _, err := editable(*g, index, id, false, what); err != nil {
			return Change{}, false, err
		}
		folded[id] = true
	}
	parentOf := func(id string) string {
		return g.Nodes[index[id]].From
	}
	// The nearest ancestor of id that is not folded: the centre is never folded, so there is one.
	landing := func(id string) string {
		p := id
		for folded[p] {
			p = parentOf(p)
		}
		return p
	}
	ancestors := map[string]bool{}
	for p := op.Into; p != ""; p = parentOf(p) {
		ancestors[p] = true
	}
	patch := Patch{}
	nodes := make([]Node, 0, len(g.Nodes))
	for i, n := range g.Nodes {
		if folded[n.Id] {
			patch.Nodes = append(patch.Nodes, PatchNode{Index: i, Node: n})
			continue
		}
		if folded[n.From] {
			patch.Nodes = append(patch.Nodes, PatchNode{Index: i, Node: n})
			if ancestors[n.Id] {
				n.From = landing(n.From)
			} else {
				n.From = op.Into
			}
		}
		nodes = append(nodes, n)
	}
	links := make([]Link, 0, len(g.Links))
	var moved []Link
	for _, l := range g.Links {
		if !folded[l.A] && !folded[l.B] {
			links = append(links, l)
		}
	}
	for _, l := range g.Links {
		if !folded[l.A] && !folded[l.B] {
			continue
		}
		patch.Links = append(patch.Links, l)
		next := l
		if folded[next.A] {
			next.A = op.Into
		}
		if folded[next.B] {
			next.B = op.Into
		}
		if next.A == next.B || hasLinkIn(links, next.A, next.B) {
			continue
		}
		links = append(links, next)
		moved = append(moved, next)
	}
	patch.LinksAdded = moved
	g.Nodes = ordered(nodes)
	g.Links = links
	return Change{Op: cleanOp(op), Undo: patch}, true, nil
}

func hasLinkIn(links []Link, a string, b string) bool {
	for _, l := range links {
		if sameLink(l, a, b) {
			return true
		}
	}
	return false
}

// ordered puts every parent before its children (graph.json's rule, ValidateGraph), keeping the order the nodes came in
// as far as it can. A node whose parent never comes stays at the end, for ValidateGraph to refuse.
func ordered(nodes []Node) []Node {
	placed := make(map[string]bool, len(nodes))
	out := make([]Node, 0, len(nodes))
	remaining := nodes
	for len(remaining) > 0 {
		var later []Node
		for _, n := range remaining {
			if n.From == "" || placed[n.From] {
				out = append(out, n)
				placed[n.Id] = true
				continue
			}
			later = append(later, n)
		}
		if len(later) == len(remaining) {
			return append(out, later...)
		}
		remaining = later
	}
	return out
}

// ApplyDeveloper applies the developer's own changes from a plate's menu (AC27): edit, retype, remove, link and unlink,
// with a block's rules. A link the developer draws carries no reason.
func ApplyDeveloper(g Graph, ops []Op, turn int, at int64) (Applied, error) {
	if len(ops) == 0 {
		return Applied{}, fmt.Errorf("no operation")
	}
	if g.Centre == "" {
		return Applied{}, fmt.Errorf("no centre yet")
	}
	for i, op := range ops {
		if !developerOps[op.Op] {
			return Applied{}, fmt.Errorf("%s: not the developer's", opLabel(i, op.Op))
		}
	}
	return Apply(g, Block{V: BlockVersion, Talk: TalkProject, Ops: ops}, turn, at)
}
