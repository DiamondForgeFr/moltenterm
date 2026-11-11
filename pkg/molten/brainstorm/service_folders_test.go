// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func (f *fixture) serviceWithBrokk(t *testing.T) (*Service, string) {
	t.Helper()
	s := f.service()
	brokk := filepath.Join(t.TempDir(), BrokkFolderName)
	s.UseResumeDir(brokk)
	return s, brokk
}

// AC10c: a switch saves the current brainstorm first, then the graph and the conversation swap, the stage starts its
// camera over, and his folder gets the resume brief of the one loaded.
func TestASwitchSavesTheCurrentOneFirst(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s, brokk := f.serviceWithBrokk(t)
	budget := saveIdea(t, f.store, "A family budget", 500)
	s.Turn(openingTurn())
	kids := *s.State().Brainstorm
	// What the developer said since the last save is in memory alone: the switch writes it before it moves.
	s.lock.Lock()
	s.session.Turns = append(s.session.Turns, Turn{Turn: 9, At: 1500, Role: RoleYou, Text: "Not yet saved"})
	s.lock.Unlock()
	before := s.State().Swap
	loaded := s.Load(SlugRequest{Slug: budget.Info.Slug})
	if loaded.Error != "" || loaded.State.Brainstorm.Slug != budget.Info.Slug || loaded.State.Graph.Centre != budget.Graph.Centre {
		t.Fatalf("the switch: %+v", loaded)
	}
	if loaded.State.Swap != before+1 || !loaded.State.Open {
		t.Errorf("swap %d, open %v", loaded.State.Swap, loaded.State.Open)
	}
	if len(loaded.Turns) != 1 || loaded.Turns[0].Text != "About A family budget" {
		t.Errorf("the conversation that came back: %+v", loaded.Turns)
	}
	back, err := f.store.LoadSlug(kids.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if last := back.Turns[len(back.Turns)-1]; last.Text != "Not yet saved" {
		t.Errorf("the brainstorm left was not saved first: its last turn is %+v", last)
	}
	resume := readText(t, filepath.Join(brokk, ResumeFile))
	if !strings.Contains(resume, "A family budget") || strings.Contains(resume, "A safe video app for children") {
		t.Errorf("the resume brief:\n%s", resume)
	}
	// A turn now grows the loaded graph, not the other one.
	more := block(add("who", KindQuestion, "Who spends?", budget.Graph.Centre))
	got := s.Turn(TurnRequest{Key: "b1", You: "Go on.", Brokk: "Who spends?", Block: &more, At: 3000})
	if !got.Applied || got.State.Brainstorm.Slug != budget.Info.Slug || len(got.State.Graph.Nodes) != 2 {
		t.Errorf("the turn after the switch: %+v", got)
	}
	if unknown := s.Load(SlugRequest{Slug: "../budget"}); unknown.Error != ReasonUnknown || unknown.State.Brainstorm.Slug != budget.Info.Slug {
		t.Errorf("an unknown slug: %+v", unknown)
	}
}

// AC10a: Load from outside the mode (Resume on the picker or on Brokk's offer) opens it on that brainstorm.
func TestLoadOpensTheModeAndNewIdeaStartsOver(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s, _ := f.serviceWithBrokk(t)
	budget := saveIdea(t, f.store, "A family budget", 500)
	loaded := s.Load(SlugRequest{Slug: budget.Info.Slug})
	if !loaded.State.Open || loaded.State.By != ByYou || loaded.State.Brainstorm == nil {
		t.Fatalf("load outside the mode: %+v", loaded.State)
	}
	fresh := s.New()
	if fresh.Error != "" || !fresh.State.Open || fresh.State.Brainstorm != nil || fresh.State.Graph != nil || fresh.State.Swap <= loaded.State.Swap {
		t.Fatalf("new idea: %+v", fresh.State)
	}
	got := s.Turn(openingTurn())
	if got.State.Brainstorm == nil || got.State.Brainstorm.Slug == budget.Info.Slug || got.State.ListRev <= fresh.State.ListRev {
		t.Errorf("the new idea's folder: %+v", got.State)
	}
}

// AC10d: forget, which the window sends from its confirmation alone, takes the folder, its resume brief and its title
// away; another brainstorm's resume brief stays.
func TestForgetRemovesTheFolderTheResumeBriefAndTheTitle(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s, brokk := f.serviceWithBrokk(t)
	trash := testTrash(t, f.store)
	budget := saveIdea(t, f.store, "A family budget", 500)
	notes := saveIdea(t, f.store, "Forge notes", 400)
	s.Load(SlugRequest{Slug: budget.Info.Slug})
	if _, err := os.Stat(filepath.Join(brokk, ResumeFile)); err != nil {
		t.Fatal(err)
	}
	got := s.Delete(SlugRequest{Slug: budget.Info.Slug})
	if got.Error != "" || !got.Trashed || got.Summary.Title != "A family budget" {
		t.Fatalf("forget: %+v", got)
	}
	if got.State.Brainstorm != nil || got.State.Graph != nil || !got.State.Open {
		t.Errorf("the forgotten brainstorm is still open: %+v", got.State)
	}
	if _, err := os.Stat(filepath.Join(brokk, ResumeFile)); !os.IsNotExist(err) {
		t.Error("its resume brief is still in his folder")
	}
	if _, err := os.Stat(filepath.Join(trash, budget.Info.Slug)); err != nil {
		t.Errorf("the folder is not in the trash: %v", err)
	}
	if titles := f.store.Titles(BriefTitles); strings.Join(titles, "|") != "Forge notes" {
		t.Errorf("his list still holds it: %v", titles)
	}
	// Forgetting another brainstorm than the one his resume brief is about leaves that brief.
	s.Load(SlugRequest{Slug: notes.Info.Slug})
	other := saveIdea(t, f.store, "A garden planner", 300)
	s.Delete(SlugRequest{Slug: other.Info.Slug})
	if _, err := os.Stat(filepath.Join(brokk, ResumeFile)); err != nil {
		t.Error("another brainstorm's forget removed the resume brief")
	}
	if again := s.Delete(SlugRequest{Slug: budget.Info.Slug}); again.Error != ReasonUnknown {
		t.Errorf("a second forget: %+v", again)
	}
}

func TestRenameKeepsTheDevelopersTitle(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s, _ := f.serviceWithBrokk(t)
	s.Turn(openingTurn())
	slug := s.State().Brainstorm.Slug
	got := s.Rename(RenameRequest{Slug: slug, Title: "Kids videos"})
	if got.Error != "" || got.State.Brainstorm.Title != "Kids videos" || got.State.Brainstorm.Slug != "kids-videos" {
		t.Fatalf("rename: %+v", got)
	}
	// His next answer renames the centre: the folder's title stays the developer's.
	again := block(centre("kids-video", "Safe videos for kids"))
	turn := s.Turn(TurnRequest{Key: "t9", You: "Yes.", Brokk: "Renamed.", Block: &again, At: 4000})
	if turn.State.Brainstorm.Title != "Kids videos" || turn.State.Brainstorm.Slug != "kids-videos" {
		t.Errorf("after his answer: %+v", turn.State.Brainstorm)
	}
	if bad := s.Rename(RenameRequest{Slug: "kids-videos", Title: strings.Repeat("x", MaxText+1)}); bad.Error != ReasonInvalid {
		t.Errorf("a title too long: %+v", bad)
	}
}

// AC11 and AC-3: Yes to his fork makes a folder with that topic at its centre, both graphs keep a reference to the
// other, and the mode moves to the new one; the one before stays saved.
func TestYesToAForkMakesAFolderAndBothReferences(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	s, brokk := f.serviceWithBrokk(t)
	if early := s.Fork(ForkRequest{Title: "Parental control for games"}); early.Error != ReasonNoIdea {
		t.Errorf("a fork with no brainstorm open: %+v", early)
	}
	s.Turn(openingTurn())
	kids := *s.State().Brainstorm
	got := s.Fork(ForkRequest{Title: "Parental control for games", Reason: "another product"})
	if got.Error != "" || got.State.Brainstorm.Slug != "parental-control-for-games" || got.State.Graph.Centre != "parental-control-for-games" {
		t.Fatalf("fork: %+v", got)
	}
	forked, err := f.store.LoadSlug("parental-control-for-games")
	if err != nil {
		t.Fatal(err)
	}
	old, err := f.store.LoadSlug(kids.Slug)
	if err != nil {
		t.Fatal(err)
	}
	refTo := func(g Graph, id string) bool {
		for _, n := range g.Nodes {
			if n.Kind == KindReference && n.Ref == id {
				return true
			}
		}
		return false
	}
	if !refTo(forked.Graph, old.Info.Id) || !refTo(old.Graph, forked.Info.Id) {
		t.Errorf("references: new %+v, old %+v", forked.Graph.Nodes, old.Graph.Nodes)
	}
	if len(forked.Info.Siblings) != 1 || forked.Info.Siblings[0] != old.Info.Id || len(old.Info.Siblings) != 1 || old.Info.Siblings[0] != forked.Info.Id {
		t.Errorf("siblings %v and %v", forked.Info.Siblings, old.Info.Siblings)
	}
	if len(old.Turns) != 2 || len(forked.Turns) != 0 {
		t.Errorf("turns: old %d, new %d", len(old.Turns), len(forked.Turns))
	}
	if !strings.Contains(readText(t, filepath.Join(brokk, ResumeFile)), "`parental-control-for-games`") {
		t.Error("the resume brief is not the new folder's")
	}
	if len(s.List().Brainstorms) != 2 {
		t.Errorf("list %+v", s.List().Brainstorms)
	}
}
