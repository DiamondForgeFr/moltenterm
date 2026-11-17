// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// The history of a brainstorm (FR-BOSS-010 AC28, DS-BOSS-010, #2247): history.jsonl in its folder keeps the last 50
// operations, one per line, each with who made it (Brokk or the developer) and what puts it back. A wrong removal can be
// undone from it, after a reload too. The graph never depends on it: a line that does not read is skipped, and an undo
// is checked against the rules of a block before it applies.

const (
	HistoryFile = "history.jsonl"
	MaxHistory  = 50
	// OpUndo names a history line that put another one back (Ref).
	OpUndo = "undo"
)

// HistoryEntry is one line of history.jsonl.
type HistoryEntry struct {
	Seq int64  `json:"seq"`
	At  int64  `json:"at"`
	By  string `json:"by"`
	Op  Op     `json:"op"`
	// Ref: the line an undo put back.
	Ref  int64  `json:"ref,omitempty"`
	Undo *Patch `json:"undo,omitempty"`
	// Undone: an undo put this line back.
	Undone bool `json:"undone,omitempty"`
	// Told: a change of the developer's that Brokk was told of with a message, or that needs no telling (undone first).
	Told bool `json:"told,omitempty"`
}

// NoteNode is a node a change names, as the views word it: its id, text and kind, plain.
type NoteNode struct {
	Id   string `json:"id"`
	Text string `json:"text,omitempty"`
	Kind string `json:"kind,omitempty"`
}

// HistoryNote is a history line as the views read it in the state, without what puts it back.
type HistoryNote struct {
	Seq int64  `json:"seq"`
	At  int64  `json:"at"`
	By  string `json:"by"`
	Op  string `json:"op"`
	// Ref and RefOp: the line an undo put back, and its operation.
	Ref   int64  `json:"ref,omitempty"`
	RefOp string `json:"refop,omitempty"`
	// Nodes: the nodes the change names (a removed node's, a link's two ends, a merge's kept node first).
	Nodes []NoteNode `json:"nodes,omitempty"`
	// Was: what an edit or a retype replaced (the text, the kind).
	Was      string `json:"was,omitempty"`
	Undone   bool   `json:"undone,omitempty"`
	Told     bool   `json:"told,omitempty"`
	Undoable bool   `json:"undoable,omitempty"`
}

func linkKey(l Link) string {
	if l.A < l.B {
		return l.A + "|" + l.B
	}
	return l.B + "|" + l.A
}

// changed is what a line changed: the nodes it added, changed or removed, and the links it added or removed. Two lines
// that changed the same node or the same link are in conflict for an undo; a later line that only needs a node (a child
// added under it) is not, and putting a line back is still checked against graph.json's rules.
func (e HistoryEntry) changed() map[string]bool {
	keys := map[string]bool{}
	if e.Undo == nil {
		return keys
	}
	for _, n := range e.Undo.Nodes {
		keys["n:"+n.Node.Id] = true
	}
	for _, id := range e.Undo.Added {
		keys["n:"+id] = true
	}
	for _, l := range e.Undo.Links {
		keys["l:"+linkKey(l)] = true
	}
	for _, l := range e.Undo.LinksAdded {
		keys["l:"+linkKey(l)] = true
	}
	return keys
}

// leansOn: the line tied a link to one of `ids`, or grew a child from one: taking those nodes away would undo it too.
func (e HistoryEntry) leansOn(ids map[string]bool) bool {
	if e.Op.Op == OpAdd && ids[e.Op.From] {
		return true
	}
	if e.Undo == nil {
		return false
	}
	for _, l := range e.Undo.Links {
		if ids[l.A] || ids[l.B] {
			return true
		}
	}
	for _, l := range e.Undo.LinksAdded {
		if ids[l.A] || ids[l.B] {
			return true
		}
	}
	return false
}

// undoable: the line can be put back: it has what puts it back, it is not an undo nor undone, it did not put the
// centre, and no later line that still stands changed the same nodes or links, or leans on a node it added.
func undoable(history []HistoryEntry, i int) bool {
	e := history[i]
	if e.Undo == nil || e.Undone || e.Op.Op == OpUndo || (e.Op.Op == OpCentre && len(e.Undo.Added) > 0) {
		return false
	}
	keys := e.changed()
	added := make(map[string]bool, len(e.Undo.Added))
	for _, id := range e.Undo.Added {
		added[id] = true
	}
	for _, later := range history[i+1:] {
		if later.Undone || later.Op.Op == OpUndo {
			continue
		}
		if len(added) > 0 && later.leansOn(added) {
			return false
		}
		for key := range later.changed() {
			if keys[key] {
				return false
			}
		}
	}
	return true
}

// appendHistory adds lines and keeps the last MaxHistory.
func appendHistory(history []HistoryEntry, entries ...HistoryEntry) []HistoryEntry {
	out := append(append([]HistoryEntry{}, history...), entries...)
	if len(out) > MaxHistory {
		out = out[len(out)-MaxHistory:]
	}
	return out
}

func nextSeq(history []HistoryEntry) int64 {
	if len(history) == 0 {
		return 1
	}
	return history[len(history)-1].Seq + 1
}

// entriesOf makes history lines of the changes one block or one hand of the developer's made.
func entriesOf(history []HistoryEntry, changes []Change, by string, at int64) []HistoryEntry {
	seq := nextSeq(history)
	out := make([]HistoryEntry, 0, len(changes))
	for _, c := range changes {
		undo := c.Undo
		out = append(out, HistoryEntry{Seq: seq, At: at, By: by, Op: c.Op, Undo: &undo})
		seq++
	}
	return out
}

// applyPatch puts back what one change did: the nodes it added go (with their links), the nodes it changed or removed
// come back as they were, at their place, and its links are put back. The result obeys graph.json's rules or is refused.
func applyPatch(g Graph, p Patch) (Graph, error) {
	added := map[string]bool{}
	for _, id := range p.Added {
		added[id] = true
	}
	if added[g.Centre] {
		return Graph{}, errors.New("the centre stays")
	}
	nodes := make([]Node, 0, len(g.Nodes)+len(p.Nodes))
	for _, n := range g.Nodes {
		if !added[n.Id] {
			nodes = append(nodes, n)
		}
	}
	for _, pn := range p.Nodes {
		replaced := false
		for i := range nodes {
			if nodes[i].Id == pn.Node.Id {
				nodes[i] = pn.Node
				replaced = true
				break
			}
		}
		if replaced {
			continue
		}
		at := min(max(pn.Index, 0), len(nodes))
		nodes = append(nodes[:at], append([]Node{pn.Node}, nodes[at:]...)...)
	}
	links := make([]Link, 0, len(g.Links)+len(p.Links))
	for _, l := range g.Links {
		own := hasLinkIn(p.LinksAdded, l.A, l.B)
		// A link of a node the change added goes with it only when the change made it: one a later change tied is
		// never taken away silently.
		if (added[l.A] || added[l.B]) && !own {
			return Graph{}, errors.New("a later link holds a node the change added")
		}
		if !own {
			links = append(links, l)
		}
	}
	for _, l := range p.Links {
		if !hasLinkIn(links, l.A, l.B) {
			links = append(links, l)
		}
	}
	return ValidateGraph(Graph{Schema: GraphSchema, Rev: g.Rev + 1, Centre: g.Centre, Nodes: ordered(nodes), Links: links})
}

func plainNode(n Node) NoteNode {
	return NoteNode{Id: n.Id, Text: cutText(CleanText(n.Text), MaxText), Kind: n.Kind}
}

// noteNodes are the nodes a line names: as they are now when they still stand, else as the line kept them.
func noteNodes(e HistoryEntry, g Graph) []NoteNode {
	kept := map[string]Node{}
	if e.Undo != nil {
		for _, pn := range e.Undo.Nodes {
			kept[pn.Node.Id] = pn.Node
		}
	}
	var ids []string
	switch e.Op.Op {
	case OpLink, OpUnlink:
		ids = []string{e.Op.A, e.Op.B}
	case OpMerge:
		ids = append([]string{e.Op.Into}, e.Op.Ids...)
	default:
		ids = []string{e.Op.Id}
	}
	out := make([]NoteNode, 0, len(ids))
	for _, id := range ids {
		if n, ok := g.node(id); ok {
			out = append(out, plainNode(n))
			continue
		}
		if n, ok := kept[id]; ok {
			out = append(out, plainNode(n))
			continue
		}
		if e.Op.Op == OpAdd || e.Op.Op == OpCentre {
			out = append(out, NoteNode{Id: id, Text: cutText(CleanText(e.Op.Text), MaxText), Kind: e.Op.Kind})
			continue
		}
		out = append(out, NoteNode{Id: id})
	}
	return out
}

// Notes is the history as the views read it, with each line's nodes worded against the graph now.
func Notes(history []HistoryEntry, g Graph) []HistoryNote {
	bySeq := make(map[int64]HistoryEntry, len(history))
	for _, e := range history {
		bySeq[e.Seq] = e
	}
	out := make([]HistoryNote, 0, len(history))
	for i, e := range history {
		note := HistoryNote{Seq: e.Seq, At: e.At, By: e.By, Op: e.Op.Op, Undone: e.Undone, Told: e.Told, Undoable: undoable(history, i)}
		subject := e
		if e.Op.Op == OpUndo {
			note.Ref = e.Ref
			if ref, ok := bySeq[e.Ref]; ok {
				note.RefOp = ref.Op.Op
				subject = ref
			}
		}
		if subject.Op.Op != OpUndo {
			note.Nodes = noteNodes(subject, g)
		}
		if e.Undo != nil && len(e.Undo.Nodes) > 0 {
			switch e.Op.Op {
			case OpEdit, OpCentre:
				note.Was = cutText(CleanText(e.Undo.Nodes[0].Node.Text), MaxText)
			case OpRetype:
				note.Was = e.Undo.Nodes[0].Node.Kind
			}
		}
		out = append(out, note)
	}
	return out
}

// UndoEntry puts back the history line seq: the graph after it, and the history with the line marked undone and an
// undo line added. A line of the developer's not told yet needs no telling once undone.
func UndoEntry(g Graph, history []HistoryEntry, seq int64, by string, at int64) (Graph, []HistoryEntry, error) {
	i := -1
	for j, e := range history {
		if e.Seq == seq {
			i = j
			break
		}
	}
	if i < 0 {
		return Graph{}, nil, ErrUnknownChange
	}
	if !undoable(history, i) {
		return Graph{}, nil, ErrChangeConflict
	}
	next, err := applyPatch(g, *history[i].Undo)
	if err != nil {
		return Graph{}, nil, fmt.Errorf("%w: %v", ErrChangeConflict, err)
	}
	out := append([]HistoryEntry{}, history...)
	out[i].Undone = true
	untold := out[i].By == ByYou && !out[i].Told
	if untold {
		out[i].Told = true
	}
	undo := HistoryEntry{Seq: nextSeq(out), At: at, By: by, Op: Op{Op: OpUndo}, Ref: seq, Told: untold || by != ByYou}
	return next, appendHistory(out, undo), nil
}

var (
	ErrUnknownChange  = errors.New("no such change in the history")
	ErrChangeConflict = errors.New("a later change touched the same nodes")
)

func historyBytes(history []HistoryEntry) ([]byte, error) {
	var buf bytes.Buffer
	for _, e := range history {
		line, err := json.Marshal(e)
		if err != nil {
			return nil, err
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

// loadHistory reads history.jsonl; a folder without one has an empty history, and a line that does not read is
// skipped (the folder is the developer's).
func loadHistory(dir string) ([]HistoryEntry, error) {
	file, err := os.Open(filepath.Join(dir, HistoryFile))
	if errors.Is(err, os.ErrNotExist) {
		return []HistoryEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	history := []HistoryEntry{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var last int64
	for scanner.Scan() {
		var e HistoryEntry
		if json.Unmarshal(scanner.Bytes(), &e) != nil || e.Seq <= last || (e.By != ByYou && e.By != ByBrokk) {
			continue
		}
		last = e.Seq
		history = append(history, e)
	}
	if len(history) > MaxHistory {
		history = history[len(history)-MaxHistory:]
	}
	return history, scanner.Err()
}
