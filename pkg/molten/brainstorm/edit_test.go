// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"reflect"
	"strings"
	"testing"
)

func remove(id string) Op {
	return Op{Op: OpRemove, Id: id, Reason: "obsolete"}
}

func ids(g Graph) []string {
	out := make([]string, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		out = append(out, n.Id)
	}
	return out
}

func parentOf(t *testing.T, g Graph, id string) string {
	t.Helper()
	n, ok := g.node(id)
	if !ok {
		t.Fatalf("%s is not in the graph", id)
	}
	return n.From
}

// A larger synthetic graph: two questions with their ideas, and cross-links between them.
func livingGraph(t *testing.T) Graph {
	t.Helper()
	return mustApply(t, sampleGraph(t), block(
		add("approved-channels", KindIdea, "Channels approved by other parents", "who-picks"),
		add("parents-pick", KindIdea, "Parents pick the videos", "who-picks"),
		add("weekly-list", KindIdea, "A weekly list", "parents-pick"),
		link("approved-channels", "three-ten"),
		link("parents-pick", "ages"),
	))
}

// FR-BOSS-010 AC26 (#2247): edit and retype change a node in place; the centre may be edited, never retyped.
func TestEditAndRetypeChangeANodeInPlace(t *testing.T) {
	t.Parallel()
	g := livingGraph(t)
	applied, err := Apply(g, block(
		Op{Op: OpEdit, Id: "ages", Text: "  For which\x1b ages, exactly? "},
		Op{Op: OpRetype, Id: "parents-list", Kind: KindDecision},
		Op{Op: OpEdit, Id: "kids-video", Text: "A safe video app for young children"},
	), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	next := applied.Graph
	ages, _ := next.node("ages")
	list, _ := next.node("parents-list")
	if ages.Text != "For which ages, exactly?" {
		t.Errorf("the edited text is %q", ages.Text)
	}
	if list.Kind != KindDecision || list.Pos != mustNode(t, g, "parents-list").Pos {
		t.Errorf("the retyped node is %+v", list)
	}
	if next.Nodes[0].Text != "A safe video app for young children" || !reflect.DeepEqual(ids(next), ids(g)) {
		t.Errorf("the centre is %+v, nodes %v", next.Nodes[0], ids(next))
	}
	if len(applied.Changes) != 3 || applied.Changes[1].Undo.Nodes[0].Node.Kind != KindIdea {
		t.Errorf("changes %+v", applied.Changes)
	}
	for name, op := range map[string]Op{
		"the centre retyped":    {Op: OpRetype, Id: "kids-video", Kind: KindIdea},
		"a retype to a topic":   {Op: OpRetype, Id: "ages", Kind: KindTopic},
		"a retype to proposal":  {Op: OpRetype, Id: "ages", Kind: KindProposal},
		"an unknown node":       {Op: OpEdit, Id: "nowhere", Text: "x"},
		"an empty text":         {Op: OpEdit, Id: "ages", Text: "  "},
		"a text too long":       {Op: OpEdit, Id: "ages", Text: strings.Repeat("x", MaxText+1)},
		"an invalid id":         {Op: OpRetype, Id: "Ages", Kind: KindIdea},
		"an edit with no id":    {Op: OpEdit, Text: "x"},
		"an unknown kind":       {Op: OpRetype, Id: "ages", Kind: "rumour"},
		"a reason too long":     {Op: OpRemove, Id: "ages", Reason: strings.Repeat("x", MaxText+1)},
		"an unlink to itself":   {Op: OpUnlink, A: "ages", B: "ages"},
		"an unlink of nothing":  {Op: OpUnlink, A: "ages", B: "nowhere"},
		"a merge of nothing":    {Op: OpMerge, Into: "ages"},
		"a merge into itself":   {Op: OpMerge, Ids: []string{"ages"}, Into: "ages"},
		"a merge naming twice":  {Op: OpMerge, Ids: []string{"three-ten", "three-ten"}, Into: "ages"},
		"a merge into nowhere":  {Op: OpMerge, Ids: []string{"three-ten"}, Into: "nowhere"},
		"a merge of the centre": {Op: OpMerge, Ids: []string{"kids-video"}, Into: "ages"},
	} {
		before := livingGraph(t)
		if _, err := Apply(before, block(add("fine", KindIdea, "fine", "kids-video"), op), 2, 2000); err == nil {
			t.Errorf("%s: applied", name)
		}
		if !reflect.DeepEqual(before, g) {
			t.Errorf("%s: the graph changed", name)
		}
	}
}

func mustNode(t *testing.T, g Graph, id string) Node {
	t.Helper()
	n, ok := g.node(id)
	if !ok {
		t.Fatalf("%s is not in the graph", id)
	}
	return n
}

// AC26: remove takes the node and its links; its children are tied to its parent; the centre always stays.
func TestRemoveTiesTheChildrenToTheParent(t *testing.T) {
	t.Parallel()
	g := livingGraph(t)
	applied, err := Apply(g, block(remove("who-picks")), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	next := applied.Graph
	if _, ok := next.node("who-picks"); ok {
		t.Fatal("the node is still there")
	}
	for _, child := range []string{"parents-list", "approved-channels", "parents-pick"} {
		if got := parentOf(t, next, child); got != "kids-video" {
			t.Errorf("%s hangs from %q, want the centre", child, got)
		}
		if mustNode(t, next, child).Pos != mustNode(t, g, child).Pos {
			t.Errorf("%s moved", child)
		}
	}
	if got := parentOf(t, next, "weekly-list"); got != "parents-pick" {
		t.Errorf("a grandchild hangs from %q", got)
	}
	if len(next.Links) != len(g.Links) {
		t.Errorf("%d links, want %d: the removed node had none", len(next.Links), len(g.Links))
	}
	if _, err := ValidateGraph(next); err != nil {
		t.Errorf("the graph breaks its rules: %v", err)
	}
	gone, err := Apply(next, block(remove("approved-channels")), 3, 3000)
	if err != nil {
		t.Fatal(err)
	}
	if len(gone.Graph.Links) != len(next.Links)-1 {
		t.Errorf("the removed node's link stayed: %+v", gone.Graph.Links)
	}
	for name, op := range map[string]Op{
		"the centre":        remove("kids-video"),
		"an unknown node":   remove("nowhere"),
		"a removed node":    remove("who-picks"),
		"a reference node":  remove("ref-forge-notes"),
		"a merge of it":     {Op: OpMerge, Ids: []string{"ref-forge-notes"}, Into: "ages"},
		"a retype of it":    {Op: OpRetype, Id: "ref-forge-notes", Kind: KindIdea},
		"an edit of it":     {Op: OpEdit, Id: "ref-forge-notes", Text: "renamed"},
		"a merge into it":   {Op: OpMerge, Ids: []string{"ages"}, Into: "ref-forge-notes"},
		"the centre merged": {Op: OpMerge, Ids: []string{"kids-video", "ages"}, Into: "three-ten"},
	} {
		with := WithReference(next, "Forge notes", "a1b2", 2500)
		if _, err := Apply(with, block(op), 3, 3000); err == nil {
			t.Errorf("%s: applied", name)
		}
	}
}

// AC26: unlink takes a cross-link away, named either way round; one already gone changes nothing.
func TestUnlinkRemovesACrossLink(t *testing.T) {
	t.Parallel()
	g := livingGraph(t)
	applied, err := Apply(g, block(Op{Op: OpUnlink, A: "three-ten", B: "approved-channels"}), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Graph.Links) != len(g.Links)-1 || hasLinkIn(applied.Graph.Links, "three-ten", "approved-channels") {
		t.Fatalf("links %+v", applied.Graph.Links)
	}
	again, err := Apply(applied.Graph, block(Op{Op: OpUnlink, A: "three-ten", B: "approved-channels"}), 3, 3000)
	if err != nil || len(again.Changes) != 0 || len(again.Graph.Links) != len(applied.Graph.Links) {
		t.Errorf("an unlink of a link gone: %v, %+v", err, again.Changes)
	}
}

// AC26: merge folds near-duplicates into one plate, which takes their children and cross-links; the graph stays a tree
// with every parent before its children, also when the kept node hung under a folded one.
func TestMergeFoldsNearDuplicates(t *testing.T) {
	t.Parallel()
	g := livingGraph(t)
	applied, err := Apply(g, block(Op{Op: OpMerge, Ids: []string{"parents-pick", "approved-channels"}, Into: "parents-list"}), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	next := applied.Graph
	for _, id := range []string{"parents-pick", "approved-channels"} {
		if _, ok := next.node(id); ok {
			t.Errorf("%s is still there", id)
		}
	}
	if got := parentOf(t, next, "weekly-list"); got != "parents-list" {
		t.Errorf("the folded node's child hangs from %q", got)
	}
	if !hasLinkIn(next.Links, "parents-list", "ages") || !hasLinkIn(next.Links, "parents-list", "three-ten") {
		t.Errorf("the cross-links did not move: %+v", next.Links)
	}
	// parents-list and three-ten were linked already: the moved link is not a second one.
	count := 0
	for _, l := range next.Links {
		if sameLink(l, "parents-list", "three-ten") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("parents-list and three-ten are linked %d times", count)
	}
	if _, err := ValidateGraph(next); err != nil {
		t.Errorf("the graph breaks its rules: %v", err)
	}

	// The kept node under a folded one: it goes up to the nearest node that stays, and the folded node's other
	// children come under it, never a loop.
	under, err := Apply(g, block(Op{Op: OpMerge, Ids: []string{"parents-pick"}, Into: "weekly-list"}), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if got := parentOf(t, under.Graph, "weekly-list"); got != "who-picks" {
		t.Errorf("the kept node hangs from %q, want who-picks", got)
	}
	if _, err := ValidateGraph(under.Graph); err != nil {
		t.Errorf("the graph breaks its rules: %v", err)
	}
	deep, err := Apply(g, block(Op{Op: OpMerge, Ids: []string{"who-picks"}, Into: "weekly-list"}), 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if got := parentOf(t, deep.Graph, "parents-pick"); got != "kids-video" {
		t.Errorf("an ancestor of the kept node hangs from %q, want the centre", got)
	}
	if got := parentOf(t, deep.Graph, "parents-list"); got != "weekly-list" {
		t.Errorf("a folded node's child hangs from %q, want the kept node", got)
	}
	if _, err := ValidateGraph(deep.Graph); err != nil {
		t.Errorf("the graph breaks its rules: %v", err)
	}
}

// AC27: the developer's hand makes edit, retype, remove, link and unlink; a merge is Brokk's.
func TestTheDeveloperMakesTheMenuOperationsOnly(t *testing.T) {
	t.Parallel()
	g := livingGraph(t)
	applied, err := ApplyDeveloper(g, []Op{{Op: OpLink, A: "weekly-list", B: "three-ten"}, remove("ages")}, 2, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Changes) != 2 || !hasLinkIn(applied.Graph.Links, "weekly-list", "three-ten") {
		t.Errorf("changes %+v", applied.Changes)
	}
	for name, ops := range map[string][]Op{
		"a merge":    {{Op: OpMerge, Ids: []string{"ages"}, Into: "who-picks"}},
		"an add":     {add("mine", KindIdea, "mine", "kids-video")},
		"a centre":   {centre("kids-video", "renamed")},
		"nothing":    nil,
		"the centre": {remove("kids-video")},
	} {
		if _, err := ApplyDeveloper(g, ops, 2, 2000); err == nil {
			t.Errorf("%s: applied", name)
		}
	}
	if _, err := ApplyDeveloper(EmptyGraph(), []Op{remove("ages")}, 1, 1); err == nil {
		t.Error("a change to a graph with no centre was applied")
	}
}

// AC28: each change puts back exactly what it did, and an undo is checked against the graph's rules.
func TestEachChangeIsUndoneExactly(t *testing.T) {
	t.Parallel()
	for name, op := range map[string]Op{
		"edit":   {Op: OpEdit, Id: "ages", Text: "Which ages?"},
		"retype": {Op: OpRetype, Id: "parents-pick", Kind: KindDecision},
		"remove": remove("who-picks"),
		"unlink": {Op: OpUnlink, A: "parents-pick", B: "ages"},
		"link":   {Op: OpLink, A: "weekly-list", B: "three-ten"},
		"merge":  {Op: OpMerge, Ids: []string{"who-picks", "ages"}, Into: "weekly-list"},
		"add":    add("devices", KindQuestion, "On which devices?", "who-picks"),
	} {
		g := livingGraph(t)
		applied, err := Apply(g, block(op), 2, 2000)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(applied.Changes) != 1 {
			t.Fatalf("%s: %d changes", name, len(applied.Changes))
		}
		back, err := applyPatch(applied.Graph, applied.Changes[0].Undo)
		if err != nil {
			t.Fatalf("%s: undo: %v", name, err)
		}
		back.Rev = g.Rev
		if !reflect.DeepEqual(nodesById(back), nodesById(g)) || !sameLinks(back.Links, g.Links) {
			t.Errorf("%s: undone to\n%+v\nwant\n%+v", name, back, g)
		}
		if _, err := ValidateGraph(back); err != nil {
			t.Errorf("%s: the undone graph breaks its rules: %v", name, err)
		}
	}
	if _, err := applyPatch(livingGraph(t), Patch{Added: []string{"kids-video"}}); err == nil {
		t.Error("an undo took the centre")
	}
}

func nodesById(g Graph) map[string]Node {
	out := make(map[string]Node, len(g.Nodes))
	for _, n := range g.Nodes {
		out[n.Id] = n
	}
	return out
}

func sameLinks(a []Link, b []Link) bool {
	if len(a) != len(b) {
		return false
	}
	for _, l := range a {
		found := false
		for _, m := range b {
			if sameLink(l, m.A, m.B) && l.Why == m.Why && l.Turn == m.Turn {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
