// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A brainstorm open on the mockup's first exchanges (synthetic): the centre, two questions, an answer, two ideas.
func editedService(t *testing.T) (*fixture, *Service) {
	t.Helper()
	f := makeFixture(t)
	s := f.service()
	s.Turn(openingTurn())
	grow := block(
		add("three-ten", KindAnswer, "From 3 to 10", "ages"),
		add("who-picks", KindQuestion, "Who picks the videos?", "kids-video"),
		add("parents-list", KindIdea, "Parents validate a list", "who-picks"),
		add("approved-channels", KindIdea, "Channels approved by other parents", "who-picks"),
		link("three-ten", "parents-list"),
	)
	if got := s.Turn(TurnRequest{Key: "t2", You: "From 3 to 10.", Brokk: "Noted. Who picks?", Block: &grow, At: 2000}); !got.Applied {
		t.Fatalf("the second turn: %+v", got)
	}
	return f, s
}

func noteOf(state State, seq int64) HistoryNote {
	for _, n := range state.History {
		if n.Seq == seq {
			return n
		}
	}
	return HistoryNote{}
}

func hasNode(state State, id string) bool {
	_, ok := state.Graph.node(id)
	return ok
}

// FR-BOSS-010 AC27 and AC28 (#2247): the developer removes a plate, its children go to its parent, the history keeps it
// with who did it, and Undo puts it back with its links; a change undone before any message needs no telling.
func TestTheDeveloperRemovesAPlateAndUndoes(t *testing.T) {
	t.Parallel()
	f, s := editedService(t)
	swap := s.State().Swap
	removed := s.Edit(EditRequest{Ops: []Op{{Op: OpRemove, Id: "who-picks"}}, Swap: &swap})
	if removed.Error != "" || len(removed.Seqs) != 1 || hasNode(removed.State, "who-picks") {
		t.Fatalf("the remove: %+v", removed)
	}
	if list, _ := removed.State.Graph.node("parents-list"); list.From != "kids-video" {
		t.Errorf("a child hangs from %q", list.From)
	}
	note := noteOf(removed.State, removed.Seqs[0])
	if note.By != ByYou || note.Op != OpRemove || !note.Undoable || note.Told || len(note.Nodes) != 1 || note.Nodes[0].Text != "Who picks the videos?" {
		t.Errorf("the history says %+v", note)
	}
	// Brokk's own adds are in the history too, by him.
	if first := removed.State.History[0]; first.By != ByBrokk || first.Op != OpCentre {
		t.Errorf("the history begins with %+v", first)
	}
	if _, err := os.Stat(filepath.Join(removed.State.Brainstorm.Dir, HistoryFile)); err != nil {
		t.Errorf("no history in the folder: %v", err)
	}
	back := s.Undo(UndoRequest{Seq: removed.Seqs[0], Swap: &swap})
	if back.Error != "" || !hasNode(back.State, "who-picks") {
		t.Fatalf("the undo: %+v", back)
	}
	if list, _ := back.State.Graph.node("parents-list"); list.From != "who-picks" {
		t.Errorf("after the undo a child hangs from %q", list.From)
	}
	undone := noteOf(back.State, removed.Seqs[0])
	undo := back.State.History[len(back.State.History)-1]
	if !undone.Undone || undone.Undoable || !undone.Told || undo.Op != OpUndo || undo.Ref != removed.Seqs[0] || undo.RefOp != OpRemove || !undo.Told {
		t.Errorf("after the undo the history says %+v and %+v", undone, undo)
	}
	if again := s.Undo(UndoRequest{Seq: removed.Seqs[0], Swap: &swap}); again.Error != ReasonConflict {
		t.Errorf("a second undo: %+v", again)
	}
	saved, err := f.store.Load(back.State.Brainstorm.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := saved.Graph.node("who-picks"); !ok || len(saved.History) != len(back.State.History) {
		t.Errorf("the folder holds %d history lines and the node %v", len(saved.History), ok)
	}
}

// AC27: the developer's edit, retype, link and unlink; a refused change leaves the graph as it was; a change on a
// brainstorm left since, or with none open, is refused.
func TestTheDevelopersChangesFollowTheBlockRules(t *testing.T) {
	t.Parallel()
	_, s := editedService(t)
	swap := s.State().Swap
	got := s.Edit(EditRequest{Ops: []Op{
		{Op: OpEdit, Id: "ages", Text: "Which ages?"},
		{Op: OpRetype, Id: "parents-list", Kind: KindDecision},
		{Op: OpLink, A: "approved-channels", B: "ages"},
		{Op: OpUnlink, A: "parents-list", B: "three-ten"},
	}, Swap: &swap})
	if got.Error != "" || len(got.Seqs) != 4 {
		t.Fatalf("the changes: %+v", got)
	}
	if ages, _ := got.State.Graph.node("ages"); ages.Text != "Which ages?" {
		t.Errorf("the text is %q", ages.Text)
	}
	if edit := noteOf(got.State, got.Seqs[0]); edit.Was != "For which ages?" || edit.Nodes[0].Text != "Which ages?" {
		t.Errorf("the edit's note %+v", edit)
	}
	if retype := noteOf(got.State, got.Seqs[1]); retype.Was != KindIdea || retype.Nodes[0].Kind != KindDecision {
		t.Errorf("the retype's note %+v", retype)
	}
	if !hasLinkIn(got.State.Graph.Links, "approved-channels", "ages") || hasLinkIn(got.State.Graph.Links, "parents-list", "three-ten") {
		t.Errorf("links %+v", got.State.Graph.Links)
	}
	rev := got.State.Graph.Rev
	for name, ops := range map[string][]Op{
		"the centre removed": {{Op: OpRemove, Id: "kids-video"}},
		"the centre retyped": {{Op: OpRetype, Id: "kids-video", Kind: KindIdea}},
		"a merge":            {{Op: OpMerge, Ids: []string{"ages"}, Into: "who-picks"}},
		"an unknown node":    {{Op: OpRemove, Id: "nowhere"}},
		"a text too long":    {{Op: OpEdit, Id: "ages", Text: strings.Repeat("x", MaxText+1)}},
	} {
		if refused := s.Edit(EditRequest{Ops: ops, Swap: &swap}); refused.Error != ReasonInvalid || refused.State.Graph.Rev != rev {
			t.Errorf("%s: %+v", name, refused)
		}
	}
	other := swap + 1
	if stale := s.Edit(EditRequest{Ops: []Op{{Op: OpRemove, Id: "ages"}}, Swap: &other}); !stale.Stale || !hasNode(stale.State, "ages") {
		t.Errorf("a change on another brainstorm: %+v", stale)
	}
	s.Close()
	if closed := s.Edit(EditRequest{Ops: []Op{{Op: OpRemove, Id: "ages"}}}); closed.Error != ReasonNoIdea {
		t.Errorf("a change with the mode closed: %+v", closed)
	}
}

// AC26: Brokk prunes in his block; the developer can put his removal back; a later change to the same node blocks the
// undo rather than lose it.
func TestBrokksPruningIsKeptAndCanBeUndone(t *testing.T) {
	t.Parallel()
	_, s := editedService(t)
	swap := s.State().Swap
	prune := block(
		Op{Op: OpRemove, Id: "approved-channels", Reason: "the developer wants a validated list"},
		Op{Op: OpRetype, Id: "parents-list", Kind: KindDecision},
	)
	got := s.Turn(TurnRequest{Key: "t3", You: "Parents validate everything.", Brokk: "Then the list. I dropped the channels.", Block: &prune, At: 3000})
	if !got.Applied || hasNode(got.State, "approved-channels") {
		t.Fatalf("his pruning: %+v", got)
	}
	n := len(got.State.History)
	removal, retype := got.State.History[n-2], got.State.History[n-1]
	if removal.By != ByBrokk || removal.Op != OpRemove || !removal.Undoable || retype.Op != OpRetype {
		t.Errorf("the history says %+v and %+v", removal, retype)
	}
	back := s.Undo(UndoRequest{Seq: removal.Seq, Swap: &swap})
	if back.Error != "" || !hasNode(back.State, "approved-channels") {
		t.Fatalf("the undo of his removal: %+v", back)
	}
	// The developer put back Brokk's change: Brokk is told with the next message.
	if undo := back.State.History[len(back.State.History)-1]; undo.By != ByYou || undo.Told {
		t.Errorf("the undo line %+v", undo)
	}
	edited := s.Edit(EditRequest{Ops: []Op{{Op: OpEdit, Id: "parents-list", Text: "Parents validate every video"}}, Swap: &swap})
	if edited.Error != "" {
		t.Fatal(edited.Error)
	}
	if blocked := s.Undo(UndoRequest{Seq: retype.Seq, Swap: &swap}); blocked.Error != ReasonConflict {
		t.Errorf("an undo under a later change: %+v", blocked)
	}
	if unknown := s.Undo(UndoRequest{Seq: 9999, Swap: &swap}); unknown.Error != ReasonUnknown {
		t.Errorf("an undo of no change: %+v", unknown)
	}
	// A block that would take the centre is dropped whole, his words kept.
	bad := block(add("devices", KindQuestion, "On which devices?", "kids-video"), Op{Op: OpRemove, Id: "kids-video"})
	dropped := s.Turn(TurnRequest{Key: "t4", You: "And devices?", Brokk: "Let me think.", Block: &bad, At: 4000})
	if !dropped.Dropped || hasNode(dropped.State, "devices") || !hasNode(dropped.State, "kids-video") {
		t.Errorf("a block taking the centre: %+v", dropped)
	}
}

// The centre's text names the brainstorm, the developer's edit of it too, until they give it a title of their own.
func TestTheDevelopersCentreEditNamesTheBrainstorm(t *testing.T) {
	t.Parallel()
	_, s := editedService(t)
	got := s.Edit(EditRequest{Ops: []Op{{Op: OpEdit, Id: "kids-video", Text: "A safe video app for young children"}}})
	if got.Error != "" || got.State.Brainstorm.Title != "A safe video app for young children" {
		t.Fatalf("after the edit the title is %q (%s)", got.State.Brainstorm.Title, got.Error)
	}
	back := s.Undo(UndoRequest{Seq: got.Seqs[0]})
	if back.State.Brainstorm.Title != "A safe video app for children" {
		t.Errorf("after the undo the title is %q", back.State.Brainstorm.Title)
	}
	slug := back.State.Brainstorm.Slug
	if renamed := s.Rename(RenameRequest{Slug: slug, Title: "Kids videos"}); renamed.Error != "" {
		t.Fatal(renamed.Error)
	}
	again := s.Edit(EditRequest{Ops: []Op{{Op: OpEdit, Id: "kids-video", Text: "Videos for children"}}})
	if again.State.Brainstorm.Title != "Kids videos" {
		t.Errorf("an edit replaced the developer's own title: %q", again.State.Brainstorm.Title)
	}
}

// AC27: the developer's changes are told once their note went with a message; up to the line named, no further.
func TestToldMarksTheDevelopersChanges(t *testing.T) {
	t.Parallel()
	_, s := editedService(t)
	first := s.Edit(EditRequest{Ops: []Op{{Op: OpRetype, Id: "parents-list", Kind: KindDecision}}})
	second := s.Edit(EditRequest{Ops: []Op{{Op: OpEdit, Id: "ages", Text: "Which ages?"}}})
	state := s.Told(ToldRequest{Seq: first.Seqs[0]})
	if !noteOf(state, first.Seqs[0]).Told || noteOf(state, second.Seqs[0]).Told {
		t.Errorf("told %+v and %+v", noteOf(state, first.Seqs[0]), noteOf(state, second.Seqs[0]))
	}
	for _, n := range state.History {
		if n.By == ByBrokk && n.Told {
			t.Errorf("a line of Brokk's was marked told: %+v", n)
		}
	}
	version := state.Version
	if again := s.Told(ToldRequest{Seq: first.Seqs[0]}); again.Version != version {
		t.Error("told again changed the state")
	}
}

// AC28: the folder keeps the last 50 operations, numbered on; after a reload the developer's last removal is still undone.
func TestTheHistoryIsCappedAndSurvivesAReload(t *testing.T) {
	t.Parallel()
	f, s := editedService(t)
	for round := 0; round < 6; round++ {
		var ops []Op
		for i := 0; i < 10; i++ {
			ops = append(ops, add(fmt.Sprintf("idea-%d-%d", round, i), KindIdea, "An idea", "kids-video"))
		}
		b := block(ops...)
		s.Turn(TurnRequest{Key: fmt.Sprintf("r%d", round), You: "More.", Brokk: "Here.", Block: &b, At: int64(5000 + round)})
	}
	removed := s.Edit(EditRequest{Ops: []Op{{Op: OpRemove, Id: "who-picks"}}})
	dir := removed.State.Brainstorm.Dir
	lines := strings.Split(strings.TrimSpace(readText(t, filepath.Join(dir, HistoryFile))), "\n")
	if len(lines) != MaxHistory || len(removed.State.History) != MaxHistory {
		t.Fatalf("the history holds %d lines, the state %d, want %d", len(lines), len(removed.State.History), MaxHistory)
	}
	if last := removed.State.History[MaxHistory-1]; last.Seq != removed.Seqs[0] || last.Seq <= int64(MaxHistory) {
		t.Errorf("the last line is %+v", last)
	}

	// A new wavesrv on the same folders: the brainstorm loads, and the removal is still put back.
	again := MakeService(f.store, s.now, f.publish, f.logf)
	loaded := again.Load(SlugRequest{Slug: removed.State.Brainstorm.Slug})
	if loaded.Error != "" || len(loaded.State.History) != MaxHistory {
		t.Fatalf("the reload: %q with %d lines", loaded.Error, len(loaded.State.History))
	}
	back := again.Undo(UndoRequest{Seq: removed.Seqs[0]})
	if back.Error != "" || !hasNode(back.State, "who-picks") {
		t.Errorf("the undo after a reload: %+v", back.Error)
	}
}

// A hand-edited history.jsonl never stops the folder loading: a line that does not read, or out of order, is skipped.
func TestABrokenHistoryLineIsSkipped(t *testing.T) {
	t.Parallel()
	f, s := editedService(t)
	dir := s.State().Brainstorm.Dir
	text := readText(t, filepath.Join(dir, HistoryFile))
	broken := "{not json\n" + text + `{"seq":1,"by":"you","op":{"op":"remove","id":"ages"}}` + "\n" + `{"seq":999,"by":"someone","op":{"op":"remove"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, HistoryFile), []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	saved, err := f.store.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if want := len(s.State().History); len(saved.History) != want {
		t.Errorf("%d lines read back, want %d", len(saved.History), want)
	}
}
