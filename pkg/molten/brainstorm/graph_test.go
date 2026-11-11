// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
)

func centre(id string, text string) Op {
	return Op{Op: OpCentre, Id: id, Text: text}
}

func add(id string, kind string, text string, from string) Op {
	return Op{Op: OpAdd, Id: id, Kind: kind, Text: text, From: from}
}

func link(a string, b string) Op {
	return Op{Op: OpLink, A: a, B: b, Why: "related"}
}

func block(ops ...Op) Block {
	return Block{V: BlockVersion, Talk: TalkProject, Ops: ops}
}

func mustApply(t *testing.T, g Graph, b Block) Graph {
	t.Helper()
	applied, err := Apply(g, b, 1, 1000)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	return applied.Graph
}

// The mockup's first exchanges (synthetic): a centre, its questions, an answer and a cross-link.
func sampleGraph(t *testing.T) Graph {
	t.Helper()
	return mustApply(t, EmptyGraph(), block(
		centre("kids-video", "A safe video app for children"),
		add("ages", KindQuestion, "For which ages?", "kids-video"),
		add("three-ten", KindAnswer, "From 3 to 10", "ages"),
		add("who-picks", KindQuestion, "Who picks the videos?", "kids-video"),
		add("parents-list", KindIdea, "Parents validate a list", "who-picks"),
		link("three-ten", "parents-list"),
	))
}

// FR-BOSS-010 AC4 and AC5 (#2246): the centre, then branches with their kind and text, each from its parent; a link.
func TestApplyGrowsTheGraph(t *testing.T) {
	t.Parallel()
	g := sampleGraph(t)
	if g.Centre != "kids-video" || g.Rev != 1 {
		t.Fatalf("centre %q rev %d", g.Centre, g.Rev)
	}
	if len(g.Nodes) != 5 || len(g.Links) != 1 {
		t.Fatalf("%d nodes and %d links, want 5 and 1", len(g.Nodes), len(g.Links))
	}
	core := g.Nodes[0]
	if core.Kind != KindTopic || core.From != "" || core.Pos != [3]float64{} {
		t.Errorf("the centre is %+v, want a topic at the origin", core)
	}
	answer, _ := g.node("three-ten")
	if answer.Kind != KindAnswer || answer.From != "ages" || answer.Status != StatusOpen || answer.Turn != 1 || answer.At != 1000 {
		t.Errorf("the answer is %+v", answer)
	}
}

// AC8: a bad block is dropped whole and the graph stays as it was.
func TestABadBlockIsDroppedWhole(t *testing.T) {
	t.Parallel()
	g := sampleGraph(t)
	long := strings.Repeat("x", MaxText+1)
	tooMany := make([]Op, MaxOps+1)
	for i := range tooMany {
		tooMany[i] = add(fmt.Sprintf("n%d", i), KindIdea, "an idea", "kids-video")
	}
	cases := map[string]Block{
		"an unknown parent":        block(add("fine", KindIdea, "fine", "kids-video"), add("lost", KindIdea, "lost", "nowhere")),
		"an id twice":              block(add("ages", KindIdea, "again", "kids-video")),
		"an id twice in the block": block(add("twin", KindIdea, "one", "kids-video"), add("twin", KindIdea, "two", "kids-video")),
		"an invalid id":            block(add("Bad Id", KindIdea, "x", "kids-video")),
		"an id too long":           block(add(strings.Repeat("a", 33), KindIdea, "x", "kids-video")),
		"an unknown kind":          block(add("odd", "rumour", "x", "kids-video")),
		"the topic kind":           block(add("odd", KindTopic, "x", "kids-video")),
		"a text too long":          block(add("long", KindIdea, long, "kids-video")),
		"an empty text":            block(add("empty", KindIdea, " \t ", "kids-video")),
		"a link to nothing":        block(link("ages", "nowhere")),
		"a node linked to itself":  block(link("ages", "ages")),
		"a second centre":          block(centre("kids-video", "renamed"), centre("other", "another")),
		"an unknown operation":     block(Op{Op: "delete", Id: "ages"}),
		"too many operations":      block(tooMany...),
		"another version":          {V: 2, Talk: TalkProject, Ops: []Op{add("v2", KindIdea, "x", "kids-video")}},
		"an unknown talk":          {V: 1, Talk: "gossip", Ops: []Op{add("gossip", KindIdea, "x", "kids-video")}},
	}
	for name, b := range cases {
		before := sampleGraph(t)
		if _, err := Apply(before, b, 2, 2000); err == nil {
			t.Errorf("%s: applied", name)
		}
		if !reflect.DeepEqual(before, g) {
			t.Errorf("%s: the graph changed", name)
		}
	}
}

func TestAnAddBeforeAnyCentreIsDropped(t *testing.T) {
	t.Parallel()
	if _, err := Apply(EmptyGraph(), block(add("orphan", KindIdea, "x", "nowhere")), 1, 1); err == nil {
		t.Error("an add was applied to a graph with no centre")
	}
}

// DS-BOSS-009: at most 400 nodes in a graph.
func TestTheGraphStopsAtItsNodeLimit(t *testing.T) {
	t.Parallel()
	g := mustApply(t, EmptyGraph(), block(centre("c", "centre")))
	for len(g.Nodes) < MaxNodes {
		var ops []Op
		for i := 0; i < MaxOps && len(g.Nodes)+len(ops) < MaxNodes; i++ {
			ops = append(ops, add(fmt.Sprintf("n%d", len(g.Nodes)+i), KindIdea, "x", "c"))
		}
		g = mustApply(t, g, block(ops...))
	}
	if _, err := Apply(g, block(add("one-more", KindIdea, "x", "c")), 9, 9); err == nil {
		t.Errorf("node %d was added", MaxNodes+1)
	}
}

func TestTheCentreIsRenamedByItsOwnId(t *testing.T) {
	t.Parallel()
	g := mustApply(t, sampleGraph(t), block(centre("kids-video", "A safe video app for young children")))
	if g.Nodes[0].Text != "A safe video app for young children" || len(g.Nodes) != 5 {
		t.Errorf("the centre is %+v with %d nodes", g.Nodes[0], len(g.Nodes))
	}
	if !StartsNewIdea(g, block(centre("budget", "A family budget"))) {
		t.Error("another centre does not start a new idea")
	}
	if StartsNewIdea(g, block(centre("kids-video", "same"))) || StartsNewIdea(EmptyGraph(), block(centre("x", "y"))) {
		t.Error("the same centre, or a first one, starts a new idea")
	}
}

// The operations of later stories (#2247 to #2250) are skipped, not dropped with the rest; a link twice is kept once.
func TestLaterOperationsAreSkippedAndLinksKeptOnce(t *testing.T) {
	t.Parallel()
	applied, err := Apply(sampleGraph(t), block(
		Op{Op: OpPropose, Id: "make-it", Text: "Make it a project", From: "kids-video"},
		link("parents-list", "three-ten"),
		add("devices", KindQuestion, "On which devices?", "kids-video"),
	), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Skipped != 1 || len(applied.Graph.Links) != 1 || !reflect.DeepEqual(applied.Added, []string{"devices"}) {
		t.Errorf("skipped %d, %d links, added %v", applied.Skipped, len(applied.Graph.Links), applied.Added)
	}
}

func TestTextsBecomeOneLineOfPlainWords(t *testing.T) {
	t.Parallel()
	g := mustApply(t, EmptyGraph(), block(centre("c", "  An idea\x1b[31m\nwith  keys\t ")))
	if got := g.Nodes[0].Text; got != "An idea [31m with keys" {
		t.Errorf("text %q", got)
	}
}

func distance(a [3]float64, b [3]float64) float64 {
	return math.Sqrt((a[0]-b[0])*(a[0]-b[0]) + (a[1]-b[1])*(a[1]-b[1]) + (a[2]-b[2])*(a[2]-b[2]))
}

// The places are seeded by the ids: the same graph stands the same way (a reloaded folder looks as it did), and no two
// nodes are born on top of each other.
func TestPlacesAreStableAndApart(t *testing.T) {
	t.Parallel()
	grow := func() Graph {
		g := mustApply(t, EmptyGraph(), block(centre("c", "centre")))
		for round := 0; round < 4; round++ {
			var ops []Op
			for i := 0; i < 10; i++ {
				from := "c"
				if round > 0 {
					from = fmt.Sprintf("r%d-%d", round-1, i%5)
				}
				ops = append(ops, add(fmt.Sprintf("r%d-%d", round, i), KindIdea, "x", from))
			}
			g = mustApply(t, g, block(ops...))
		}
		return g
	}
	a, b := grow(), grow()
	if !reflect.DeepEqual(a, b) {
		t.Fatal("the same graph grew to other places")
	}
	// Each node is born a plate's gap from the ones before it (a later one may push into an earlier one's gap only by
	// the pushes' rounding).
	for j := 1; j < len(a.Nodes); j++ {
		for i := 0; i < j; i++ {
			d := vec3(a.Nodes[j].Pos).sub(vec3(a.Nodes[i].Pos))
			if gapOf(d) < 0.95 {
				t.Errorf("%s was born %.2f gaps from %s", a.Nodes[j].Id, gapOf(d), a.Nodes[i].Id)
			}
		}
	}
	// A relief more than a ball: far more spread across and up than in depth.
	var spreadXY, spreadZ float64
	for _, n := range a.Nodes {
		spreadXY = math.Max(spreadXY, math.Hypot(n.Pos[0], n.Pos[1]))
		spreadZ = math.Max(spreadZ, math.Abs(n.Pos[2]))
	}
	if spreadZ > spreadXY/2 {
		t.Errorf("depth %.1f against a spread of %.1f", spreadZ, spreadXY)
	}
	first, _ := a.node("r0-0")
	if d := distance(first.Pos, [3]float64{}); d < firstRing*0.7 || d > firstRing*2 {
		t.Errorf("a first branch stands %.1f from the centre", d)
	}
}
