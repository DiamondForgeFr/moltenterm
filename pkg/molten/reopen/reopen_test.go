// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func entry(ws string, name string) Entry {
	return Entry{Actor: ActorUser, Action: ActionClose, Target: Target{Kind: KindPane, WorkspaceId: ws, Name: name}}
}

func TestStacksKeepTheLastClosesPerWorkspace(t *testing.T) {
	s := MakeStacks()
	for i := 0; i < StackSize+3; i++ {
		s.Push(entry("w1", fmt.Sprintf("p%d", i)))
	}
	s.Push(entry("w2", "other"))
	if s.Len("w1") != StackSize {
		t.Fatalf("w1 keeps %d", s.Len("w1"))
	}
	for i := StackSize + 2; i >= 3; i-- {
		e, ok := s.Pop("w1")
		if !ok || e.Target.Name != fmt.Sprintf("p%d", i) {
			t.Fatalf("pop %d: %+v %v", i, e, ok)
		}
	}
	if _, ok := s.Pop("w1"); ok {
		t.Fatal("the oldest closes were dropped")
	}
	if e, ok := s.Pop("w2"); !ok || e.Target.Name != "other" {
		t.Fatalf("each workspace has its own stack: %+v", e)
	}
}

func TestCleanMetaDropsPendingRequests(t *testing.T) {
	meta := waveobj.MetaMapType{
		"view":                             molten.BrowserView,
		molten.BrowserTabsMetaKey:          []any{map[string]any{"url": "https://example.com"}},
		molten.BrowserActiveMetaKey:        "t1",
		molten.BrowserOpenKeyPrefix + "1":  "https://x",
		molten.BrowserCloseKeyPrefix + "1": true,
		molten.BrowserAskMetaKey:           "a",
		"cmd:cwd":                          "/w",
		"gone":                             nil,
	}
	got := CleanMeta(meta)
	if len(got) != 4 || got["cmd:cwd"] != "/w" || got[molten.BrowserActiveMetaKey] != "t1" || got[molten.BrowserTabsMetaKey] == nil {
		t.Fatalf("clean %v", got)
	}
}

func TestPaneName(t *testing.T) {
	cases := map[string]waveobj.MetaMapType{
		"the terminal":    {"view": "term"},
		"the browser":     {"view": molten.BrowserView},
		"main.go":         {"view": "preview", "file": "/w/src/main.go"},
		"My title":        {"view": "term", "frame:title": "My title"},
		"the system info": {"view": "sysinfo"}, "the widget": {"view": "widget"},
		"the pane":      {},
		"the file view": {"view": "preview"},
	}
	for want, meta := range cases {
		if got := PaneName(meta); got != want {
			t.Errorf("PaneName(%v) = %q, want %q", meta, got, want)
		}
	}
}

func tree(t *testing.T, src string) any {
	var node any
	if err := json.Unmarshal([]byte(src), &node); err != nil {
		t.Fatal(err)
	}
	return node
}

func leafJSON(id string) string {
	return fmt.Sprintf(`{"id":"n-%s","data":{"blockId":"%s"}}`, id, id)
}

func TestPanePlacementBesideItsNeighbour(t *testing.T) {
	// row [A, column [B, C], D, column [E, row [F, G], H]]
	root := tree(t, `{"id":"r","flexDirection":"row","children":[`+leafJSON("A")+`,{"id":"c","flexDirection":"column","children":[`+leafJSON("B")+`,`+leafJSON("C")+`]},`+leafJSON("D")+
		`,{"id":"c2","flexDirection":"column","children":[`+leafJSON("E")+`,{"id":"r2","flexDirection":"row","children":[`+leafJSON("F")+`,`+leafJSON("G")+`]},`+leafJSON("H")+`]}]}`)
	type spot struct {
		place molten.PanePlacement
		index string
	}
	cases := map[string]spot{
		// A's only neighbour is a split: it goes back left of that split's first panel.
		"A": {molten.PanePlacement{TargetBlockId: "B", Split: "left"}, "[]"},
		"B": {molten.PanePlacement{TargetBlockId: "C", Split: "up"}, "[]"},
		"C": {molten.PanePlacement{TargetBlockId: "B", Split: "down"}, "[]"},
		// Between two splits: at its index in the row.
		"D": {molten.PanePlacement{}, "[1]"},
		"H": {molten.PanePlacement{}, "[3 1]"},
		"X": {molten.PanePlacement{}, "[]"},
	}
	for block, want := range cases {
		place, indexArr := PanePlacement(root, block)
		if place != want.place || fmt.Sprint(indexArr) != want.index {
			t.Errorf("PanePlacement(%s) = %+v %v, want %+v %s", block, place, indexArr, want.place, want.index)
		}
	}
	// The last pane of the tab after a split: back at its index, not inside the split.
	last := tree(t, `{"id":"r","flexDirection":"row","children":[`+leafJSON("A")+`,{"id":"c","flexDirection":"column","children":[`+leafJSON("B")+`,`+leafJSON("C")+`]},`+leafJSON("T")+`]}`)
	if place, indexArr := PanePlacement(last, "T"); place != (molten.PanePlacement{}) || fmt.Sprint(indexArr) != "[1]" {
		t.Errorf("last pane: %+v %v", place, indexArr)
	}
	alone := tree(t, leafJSON("A"))
	if place, indexArr := PanePlacement(alone, "A"); place != (molten.PanePlacement{}) || indexArr != nil {
		t.Errorf("a pane alone: %+v %v", place, indexArr)
	}
}

func TestLayoutLeavesRebuildsBySplits(t *testing.T) {
	// row [column [A, B], C, column [D, row [E, F]]], F focused
	root := tree(t, `{"id":"r","flexDirection":"row","children":[`+
		`{"id":"c1","flexDirection":"column","children":[`+leafJSON("A")+`,`+leafJSON("B")+`]},`+
		leafJSON("C")+`,`+
		`{"id":"c2","flexDirection":"column","children":[`+leafJSON("D")+`,{"id":"r2","flexDirection":"row","children":[`+leafJSON("E")+`,`+leafJSON("F")+`]}]}]}`)
	meta := func(id string) (map[string]any, bool) {
		if id == "gone" {
			return nil, false
		}
		return map[string]any{"name": id}, true
	}
	leaves := LayoutLeaves(root, "n-F", meta)
	var got []string
	for _, l := range leaves {
		target := "-"
		if l.Target >= 0 {
			target = leaves[l.Target].Meta["name"].(string)
		}
		got = append(got, fmt.Sprintf("%s>%s:%s%v", l.Meta["name"], target, l.Split, l.Focused))
	}
	want := []string{"A>-:false", "C>A:rightfalse", "D>C:rightfalse", "B>A:downfalse", "E>D:downfalse", "F>E:righttrue"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("leaves\n got %v\nwant %v", got, want)
	}
}

func TestLayoutLeavesSkipsGoneBlocks(t *testing.T) {
	root := tree(t, `{"id":"r","flexDirection":"row","children":[`+leafJSON("gone")+`,`+leafJSON("B")+`,`+leafJSON("C")+`]}`)
	meta := func(id string) (map[string]any, bool) {
		if id == "gone" {
			return nil, false
		}
		return map[string]any{"name": id}, true
	}
	leaves := LayoutLeaves(root, "", meta)
	if len(leaves) != 2 || leaves[0].Target != -1 || leaves[1].Target != 0 || leaves[1].Split != "right" {
		t.Fatalf("leaves %+v", leaves)
	}
}
