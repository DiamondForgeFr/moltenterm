// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package contexts

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func workspaces(ids ...string) map[string]waveobj.MetaMapType {
	rtn := map[string]waveobj.MetaMapType{}
	for _, id := range ids {
		rtn[id] = waveobj.MetaMapType{}
	}
	return rtn
}

func ids(list []Context) []string {
	rtn := []string{}
	for _, c := range list {
		rtn = append(rtn, c.Id)
	}
	return rtn
}

func mustCreate(t *testing.T, s State, name string, id string, ws ...string) (State, []string) {
	t.Helper()
	next, moved, err := s.Create(CreateRequest{Name: name, Workspaces: ws}, id)
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return next, moved
}

// The migration (#2476): an installation that stored nothing holds one context with every workspace, and nothing is
// written for it.
func TestNoStoredContextsIsOneDefaultContextWithEveryWorkspace(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "c"))
	if len(s.Contexts) != 1 || s.Contexts[0].Id != DefaultId || s.Contexts[0].Name != "" {
		t.Fatalf("want the default context alone, got %+v", s.Contexts)
	}
	for _, id := range []string{"a", "b", "c"} {
		if s.Of[id] != DefaultId {
			t.Fatalf("workspace %s is in %q, want the default context", id, s.Of[id])
		}
	}
	if Stored(waveobj.MetaMapType{}) {
		t.Fatalf("no list is stored, so nothing was written")
	}
}

func TestUnreadableOrEmptyStoredListIsTheDefaultContext(t *testing.T) {
	for _, raw := range []any{nil, "nonsense", 7, []any{}, []any{map[string]any{"name": "no id"}}, []any{"x"}} {
		got := ReadContexts(waveobj.MetaMapType{ClientMetaKey: raw})
		if len(got) != 1 || got[0].Id != DefaultId {
			t.Errorf("stored %v: got %+v, want the default context", raw, got)
		}
	}
}

func TestReadDropsEntriesWithoutIdAndRepeatedIds(t *testing.T) {
	meta := waveobj.MetaMapType{ClientMetaKey: []any{
		map[string]any{"id": "a", "name": "A"},
		map[string]any{"name": "no id"},
		map[string]any{"id": "a", "name": "again"},
		map[string]any{"id": "b", "name": "B", "emblem": "book", "last": "w1"},
	}}
	got := ReadContexts(meta)
	if !slices.Equal(ids(got), []string{"a", "b"}) || got[0].Name != "A" || got[1].Last != "w1" || got[1].Emblem != "book" {
		t.Fatalf("got %+v", got)
	}
}

func TestWorkspaceWithoutOrWithUnknownContextIsInTheFirst(t *testing.T) {
	list := []Context{{Id: "first"}, {Id: "second"}}
	cases := map[string]waveobj.MetaMapType{
		"no meta":      nil,
		"empty":        {},
		"unknown":      {WorkspaceMetaKey: "gone"},
		"not a string": {WorkspaceMetaKey: 4},
	}
	for name, meta := range cases {
		if got := ContextOf(list, meta); got != "first" {
			t.Errorf("%s: in %q, want the first context", name, got)
		}
	}
	if got := ContextOf(list, waveobj.MetaMapType{WorkspaceMetaKey: "second"}); got != "second" {
		t.Errorf("a named context: in %q", got)
	}
}

func TestCreateAddsAfterTheOthersAndMovesTheListedWorkspaces(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "c"))
	next, moved := mustCreate(t, s, "  DiamondForge  ", "df", "b", "c")
	if !slices.Equal(ids(next.Contexts), []string{DefaultId, "df"}) {
		t.Fatalf("order: %v", ids(next.Contexts))
	}
	if next.Contexts[1].Name != "DiamondForge" || next.Contexts[1].Emblem != FallbackEmblem {
		t.Fatalf("a name is trimmed and an empty emblem gets the fallback: %+v", next.Contexts[1])
	}
	slices.Sort(moved)
	if !slices.Equal(moved, []string{"b", "c"}) {
		t.Fatalf("moved %v", moved)
	}
	if !slices.Equal(next.Members("df"), []string{"b", "c"}) || !slices.Equal(next.Members(DefaultId), []string{"a"}) {
		t.Fatalf("membership: %v / %v", next.Members("df"), next.Members(DefaultId))
	}
	if s.Of["b"] != DefaultId {
		t.Fatalf("the state it came from is not changed")
	}
}

func TestCreateRefusesBadInput(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	bad := []struct {
		name string
		req  CreateRequest
		id   string
	}{
		{"no name", CreateRequest{Name: "   "}, "x"},
		{"unknown workspace", CreateRequest{Name: "N", Workspaces: []string{"nope"}}, "x"},
		{"emblem not a name", CreateRequest{Name: "N", Emblem: "../etc"}, "x"},
		{"emblem emoji", CreateRequest{Name: "N", Emblem: "🔥"}, "x"},
		{"taken id", CreateRequest{Name: "N"}, DefaultId},
		{"no id", CreateRequest{Name: "N"}, ""},
	}
	for _, c := range bad {
		if _, _, err := s.Create(c.req, c.id); err == nil {
			t.Errorf("%s: created", c.name)
		}
	}
}

// A name is one clean line. A description is text on several lines (#2518): its line breaks stay, each line is clean, a
// run of blank lines is one, and the whole is cut at MaxDescriptionRunes.
func TestNamesAreOneCleanLineAndDescriptionsKeepTheirLines(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	long := strings.Repeat("é", MaxNameRunes+20)
	next, _, err := s.Create(CreateRequest{Name: "Day\tjob\n2", Description: " line one\r\nline\ttwo ", Emblem: "briefcase"}, "x")
	if err != nil {
		t.Fatal(err)
	}
	if got := next.Contexts[1]; got.Name != "Day job 2" || got.Description != "line one\nline two" {
		t.Fatalf("got %+v", got)
	}
	for in, want := range map[string]string{
		"first\n\n\n\nsecond":        "first\n\nsecond",
		"\n\n  lead and trail  \n\n": "lead and trail",
		"a  b\r\rc":                  "a b\n\nc",
		"  \n  ":                     "",
		"one\u0007bell\nline":        "one bell\nline",
	} {
		got := cleanText(in, MaxDescriptionRunes)
		if got != want {
			t.Errorf("cleanText(%q) = %q, want %q", in, got, want)
		}
	}
	lines := strings.Repeat("d", MaxDescriptionRunes-3) + "\nxyz\nmore"
	if got := cleanText(lines, MaxDescriptionRunes); len([]rune(got)) != MaxDescriptionRunes || !strings.HasSuffix(got, "\nxy") {
		t.Fatalf("a long description is cut at the limit, keeping its lines: %q", got)
	}
	next, _, err = s.Create(CreateRequest{Name: long, Description: strings.Repeat("d", MaxDescriptionRunes+5)}, "y")
	if err != nil {
		t.Fatal(err)
	}
	if n := len([]rune(next.Contexts[1].Name)); n != MaxNameRunes {
		t.Fatalf("name cut to %d runes, got %d", MaxNameRunes, n)
	}
	if n := len([]rune(next.Contexts[1].Description)); n != MaxDescriptionRunes {
		t.Fatalf("description cut to %d runes, got %d", MaxDescriptionRunes, n)
	}
}

func TestUpdateChangesOnlyWhatItSets(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{ClientMetaKey: []any{
		map[string]any{"id": "a", "name": "A", "description": "d", "emblem": "book"},
	}}, workspaces("w"))
	name := "Renamed"
	next, moved, err := s.Update(UpdateRequest{Id: "a", Name: &name})
	if err != nil || len(moved) != 0 {
		t.Fatalf("err %v moved %v", err, moved)
	}
	if got := next.Contexts[0]; got.Name != "Renamed" || got.Description != "d" || got.Emblem != "book" {
		t.Fatalf("got %+v", got)
	}
	empty := ""
	if _, _, err := s.Update(UpdateRequest{Id: "a", Name: &empty}); err == nil {
		t.Fatalf("a context cannot lose its name")
	}
	bad := "Not An Icon"
	if _, _, err := s.Update(UpdateRequest{Id: "a", Emblem: &bad}); err == nil {
		t.Fatalf("an emblem that is not an icon name was taken")
	}
	if _, _, err := s.Update(UpdateRequest{Id: "nope", Name: &name}); err == nil {
		t.Fatalf("an unknown context was updated")
	}
}

func TestUpdateMovesOnlyTheWorkspacesItNames(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "c", "d", "blank"))
	s, _ = mustCreate(t, s, "Second", "two", "c", "d", "blank")
	next, moved, err := s.Update(UpdateRequest{Id: "two", AddWorkspaces: []string{"a"}, RemoveWorkspaces: []string{"d"}})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(moved)
	if !slices.Equal(moved, []string{"a", "d"}) {
		t.Fatalf("moved %v: a comes in, d goes to the first other context", moved)
	}
	if !slices.Equal(next.Members("two"), []string{"a", "blank", "c"}) || !slices.Equal(next.Members(DefaultId), []string{"b", "d"}) {
		t.Fatalf("membership: %v / %v", next.Members("two"), next.Members(DefaultId))
	}
}

// The form knows only the workspaces its checklist showed. A blank workspace of another window, or one placed after the
// dialog opened, is not on it, and saving the form must leave it where it is.
func TestUpdateLeavesTheWorkspacesTheFormDidNotKnow(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "blank", "late"))
	s, _ = mustCreate(t, s, "Second", "two", "blank", "late")
	name := "Renamed"
	next, moved, err := s.Update(UpdateRequest{Id: "two", Name: &name, AddWorkspaces: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(moved, []string{"a"}) {
		t.Fatalf("only the added workspace moves: %v", moved)
	}
	if !slices.Equal(next.Members("two"), []string{"a", "blank", "late"}) {
		t.Fatalf("an unlisted workspace left the context: %v", next.Members("two"))
	}
}

func TestUpdateRemovesOnlyWhatIsInTheContext(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "c"))
	s, _ = mustCreate(t, s, "Second", "two", "c")
	next, moved, err := s.Update(UpdateRequest{Id: "two", RemoveWorkspaces: []string{"a", "ghost"}})
	if err != nil || len(moved) != 0 {
		t.Fatalf("a workspace of another context, or one that is gone, is not moved: %v %v", moved, err)
	}
	if !slices.Equal(next.Members(DefaultId), []string{"a", "b"}) {
		t.Fatalf("a workspace of the first context was moved by a removal from the second: %v", next.Members(DefaultId))
	}
	if _, _, err := s.Update(UpdateRequest{Id: "two", AddWorkspaces: []string{"a"}, RemoveWorkspaces: []string{"a"}}); err == nil {
		t.Fatalf("a workspace was asked to come in and to leave")
	}
}

func TestUpdateWorkspacesOfTheOnlyContextCannotLeaveIt(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	if _, _, err := s.Update(UpdateRequest{Id: DefaultId, RemoveWorkspaces: []string{"a"}}); err == nil {
		t.Fatalf("a workspace left the only context")
	}
	if _, moved, err := s.Update(UpdateRequest{Id: DefaultId, AddWorkspaces: []string{"a", "b"}}); err != nil || len(moved) != 0 {
		t.Fatalf("adding what it holds is a no-op: %v %v", moved, err)
	}
	if _, _, err := s.Update(UpdateRequest{Id: DefaultId, AddWorkspaces: []string{"a", "ghost"}}); err == nil {
		t.Fatalf("an unknown workspace was added")
	}
}

func TestDeleteMovesItsWorkspacesAndTheLastContextStays(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b", "c"))
	s, _ = mustCreate(t, s, "Second", "two", "b")
	s, _ = mustCreate(t, s, "Third", "three", "c")
	next, moved, err := s.Delete(DeleteRequest{Id: "two", MoveTo: "three"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(moved, []string{"b"}) || !slices.Equal(ids(next.Contexts), []string{DefaultId, "three"}) {
		t.Fatalf("moved %v contexts %v", moved, ids(next.Contexts))
	}
	if !slices.Equal(next.Members("three"), []string{"b", "c"}) {
		t.Fatalf("members of three: %v", next.Members("three"))
	}
	if _, _, err := (State{Contexts: []Context{Default()}, Of: map[string]string{"a": DefaultId}}).Delete(DeleteRequest{Id: DefaultId}); err == nil {
		t.Fatalf("the last context was deleted")
	}
	if _, _, err := s.Delete(DeleteRequest{Id: "two", MoveTo: "two"}); err == nil {
		t.Fatalf("a context was asked to take its own workspaces")
	}
	if _, _, err := s.Delete(DeleteRequest{Id: "two", MoveTo: "ghost"}); err == nil {
		t.Fatalf("the workspaces went to a context that does not exist")
	}
}

// The workspaces that never carried an id belonged to the first context: deleting it writes them into the context that
// takes them, so the new first context does not inherit by accident what the first rule gave the old one.
func TestDeletingTheFirstContextMovesItsImplicitWorkspacesExplicitly(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	s, _ = mustCreate(t, s, "Second", "two", "b")
	next, moved, err := s.Delete(DeleteRequest{Id: DefaultId})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(moved, []string{"a"}) {
		t.Fatalf("moved %v: a had no id and is written", moved)
	}
	if next.Of["a"] != "two" || next.Of["b"] != "two" {
		t.Fatalf("both are in the second context now: %v", next.Of)
	}
}

func TestAssignPutsOneWorkspaceInAContext(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	s, _ = mustCreate(t, s, "Second", "two")
	next, moved, err := s.Assign(AssignRequest{WorkspaceId: "a", ContextId: "two"})
	if err != nil || !slices.Equal(moved, []string{"a"}) || next.Of["a"] != "two" {
		t.Fatalf("moved %v err %v of %v", moved, err, next.Of)
	}
	_, moved, err = next.Assign(AssignRequest{WorkspaceId: "a", ContextId: "two"})
	if err != nil || len(moved) != 0 {
		t.Fatalf("assigning where it already is writes nothing: %v %v", moved, err)
	}
	if _, _, err := s.Assign(AssignRequest{WorkspaceId: "ghost", ContextId: "two"}); err == nil {
		t.Fatalf("a workspace that does not exist was assigned")
	}
	if _, _, err := s.Assign(AssignRequest{WorkspaceId: "a", ContextId: "ghost"}); err == nil {
		t.Fatalf("a workspace was assigned to a context that does not exist")
	}
}

func TestTouchRemembersTheLastWorkspaceOfItsOwnContextOnly(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	s, _ = mustCreate(t, s, "Second", "two", "b")
	next, err := s.Touch(TouchRequest{ContextId: "two", WorkspaceId: "b"})
	if err != nil || next.Contexts[1].Last != "b" {
		t.Fatalf("got %+v err %v", next.Contexts, err)
	}
	same, err := next.Touch(TouchRequest{ContextId: "two", WorkspaceId: "b"})
	if err != nil || !SameContexts(same.Contexts, next.Contexts) {
		t.Fatalf("touching again changes nothing")
	}
	other, err := s.Touch(TouchRequest{ContextId: "two", WorkspaceId: "a"})
	if err != nil || other.Contexts[1].Last != "" {
		t.Fatalf("a workspace of another context was remembered: %+v", other.Contexts)
	}
	if _, err := s.Touch(TouchRequest{ContextId: "ghost", WorkspaceId: "a"}); err == nil {
		t.Fatalf("an unknown context was touched")
	}
}

func TestMovingAWorkspaceAwayForgetsItAsTheLastOne(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a", "b"))
	s, _ = mustCreate(t, s, "Second", "two", "b")
	s, _ = s.Touch(TouchRequest{ContextId: "two", WorkspaceId: "b"})
	next, _, err := s.Assign(AssignRequest{WorkspaceId: "b", ContextId: DefaultId})
	if err != nil {
		t.Fatal(err)
	}
	if next.Contexts[1].Last != "" {
		t.Fatalf("the context still names a workspace it no longer holds: %+v", next.Contexts[1])
	}
}

func TestSameIgnoringLastTellsARememberedWorkspaceFromARealChange(t *testing.T) {
	a := []Context{{Id: "a", Name: "A"}, {Id: "b", Last: "w1"}}
	b := []Context{{Id: "a", Name: "A", Last: "w9"}, {Id: "b", Last: "w2"}}
	if !SameIgnoringLast(a, b) {
		t.Fatalf("only the remembered workspaces differ")
	}
	if SameContexts(a, b) {
		t.Fatalf("the lists are not the same")
	}
	renamed := []Context{{Id: "a", Name: "Renamed"}, {Id: "b", Last: "w1"}}
	if SameIgnoringLast(a, renamed) {
		t.Fatalf("a rename is a change")
	}
	if SameIgnoringLast(a, a[:1]) {
		t.Fatalf("a context less is a change")
	}
}

func TestMetaValueRoundTrips(t *testing.T) {
	list := []Context{{Id: "a", Name: "A", Description: "d", Emblem: "book", Shape: "arrow", Last: "w", Folder: "/c"}, {Id: "b"}}
	got := ReadContexts(waveobj.MetaMapType{ClientMetaKey: MetaValue(list)})
	if !SameContexts(got, list) {
		t.Fatalf("got %+v, want %+v", got, list)
	}
}

// #2516: a context's folder is set, cleaned and forgotten by Update, and is the folder of its workspaces only.
func TestUpdateSetsTheContextsFolder(t *testing.T) {
	s, _ := mustCreate(t, MakeState(nil, workspaces("w1", "w2")), "Client", "c", "w1")
	folder := "/clients/sefers/"
	next, moved, err := s.Update(UpdateRequest{Id: "c", Folder: &folder})
	if err != nil || len(moved) != 0 {
		t.Fatalf("update: %v, moved %v", err, moved)
	}
	if got := FolderOf(next.Contexts, waveobj.MetaMapType{WorkspaceMetaKey: "c"}); got != "/clients/sefers" {
		t.Fatalf("folder %q", got)
	}
	if got := FolderOf(next.Contexts, waveobj.MetaMapType{}); got != "" {
		t.Fatalf("a workspace of the first context got %q", got)
	}
	relative := "sefers"
	if _, _, err := next.Update(UpdateRequest{Id: "c", Folder: &relative}); err == nil {
		t.Fatalf("a relative folder was taken")
	}
	empty := ""
	cleared, _, err := next.Update(UpdateRequest{Id: "c", Folder: &empty})
	if err != nil || FolderOf(cleared.Contexts, waveobj.MetaMapType{WorkspaceMetaKey: "c"}) != "" {
		t.Fatalf("forgetting the folder: %v", err)
	}
}

// The ribbon's end shapes (#2519): a context stores the one it carries, among fifteen.
func TestTheRibbonHasFifteenDistinctShapes(t *testing.T) {
	if len(ShapeIds) != 15 {
		t.Fatalf("want 15 shapes, got %d", len(ShapeIds))
	}
	seen := map[string]bool{}
	for _, id := range ShapeIds {
		if seen[id] || !emblemPattern.MatchString(id) {
			t.Fatalf("shape %q is repeated or not a plain id", id)
		}
		seen[id] = true
	}
}

func TestCreateStoresTheShapeAndRefusesAnUnknownOne(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("a"))
	next, _, err := s.Create(CreateRequest{Name: "N", Shape: " moon "}, "x")
	if err != nil || next.Contexts[1].Shape != "moon" {
		t.Fatalf("err %v, got %+v", err, next.Contexts)
	}
	next, _, err = s.Create(CreateRequest{Name: "N"}, "y")
	if err != nil || next.Contexts[1].Shape != "" {
		t.Fatalf("a client that sends no shape leaves it empty for the migration: err %v, got %+v", err, next.Contexts)
	}
	for _, bad := range []string{"triangle", "V", "../v", "🔥"} {
		if _, _, err := s.Create(CreateRequest{Name: "N", Shape: bad}, "z"); err == nil {
			t.Errorf("created with the shape %q", bad)
		}
	}
}

func TestUpdateChangesTheShapeOnlyToAKnownOne(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{ClientMetaKey: []any{
		map[string]any{"id": "a", "name": "A", "shape": "v"},
	}}, workspaces("w"))
	shape := "facet"
	next, _, err := s.Update(UpdateRequest{Id: "a", Shape: &shape})
	if err != nil || next.Contexts[0].Shape != "facet" || next.Contexts[0].Name != "A" {
		t.Fatalf("err %v, got %+v", err, next.Contexts)
	}
	for _, bad := range []string{"", "triangle"} {
		if _, _, err := s.Update(UpdateRequest{Id: "a", Shape: &bad}); err == nil {
			t.Errorf("a context took the shape %q", bad)
		}
	}
	if s.Contexts[0].Shape != "v" {
		t.Fatalf("the state it came from is not changed")
	}
}

// The migration: contexts stored before shapes existed get theirs once, and the first write wins.
func TestAssignShapesFillsOnlyTheContextsThatHaveNone(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{ClientMetaKey: []any{
		map[string]any{"id": "a", "name": "A"},
		map[string]any{"id": "b", "name": "B", "shape": "round"},
		map[string]any{"id": "c", "name": "C"},
	}}, workspaces("w"))
	next, err := s.AssignShapes(ShapesRequest{Shapes: map[string]string{"a": "v", "b": "arrow", "c": "blade", "gone": "moon"}})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{next.Contexts[0].Shape, next.Contexts[1].Shape, next.Contexts[2].Shape}
	if !slices.Equal(got, []string{"v", "round", "blade"}) {
		t.Fatalf("shapes %v: a context keeps the one it has and an unknown id is skipped", got)
	}
	again, err := next.AssignShapes(ShapesRequest{Shapes: map[string]string{"a": "facet", "c": "facet"}})
	if err != nil || !SameContexts(again.Contexts, next.Contexts) {
		t.Fatalf("a second window's draw changed the list: err %v, %+v", err, again.Contexts)
	}
	if s.Contexts[0].Shape != "" {
		t.Fatalf("the state it came from is not changed")
	}
}

func TestAssignShapesRefusesAnUnknownShape(t *testing.T) {
	s := MakeState(waveobj.MetaMapType{}, workspaces("w"))
	if _, err := s.AssignShapes(ShapesRequest{Shapes: map[string]string{DefaultId: "v", "x": "triangle"}}); err == nil {
		t.Fatalf("a request naming an unknown shape was taken")
	}
}

// #2518: the folder is set and cleared on its own, for one context, without the rest of the update form.
func TestSetFolderSetsAndClearsOneContextsFolder(t *testing.T) {
	s, _ := mustCreate(t, MakeState(nil, workspaces("w1", "w2")), "Client", "c", "w1")
	s, _ = mustCreate(t, s, "Other", "o", "w2")
	of := func(state State, workspace string) string {
		return FolderOf(state.Contexts, waveobj.MetaMapType{WorkspaceMetaKey: state.Of[workspace]})
	}

	set, err := s.SetFolder(FolderRequest{Id: "c", Folder: "/clients/sefers/"})
	if err != nil {
		t.Fatalf("setting the folder: %v", err)
	}
	if of(set, "w1") != "/clients/sefers" {
		t.Fatalf("the folder is kept cleaned: %q", of(set, "w1"))
	}
	if of(set, "w2") != "" || of(set, "nobody") != "" {
		t.Fatalf("another context took the folder: %+v", set.Contexts)
	}
	if set.Of["w1"] != "c" || set.Contexts[1].Name != "Client" {
		t.Fatalf("setting the folder changed more than the folder: %+v", set)
	}

	again, err := set.SetFolder(FolderRequest{Id: "c", Folder: "/clients/sefers"})
	if err != nil || !SameContexts(again.Contexts, set.Contexts) {
		t.Fatalf("setting the same folder again changed the contexts: %v %+v", err, again.Contexts)
	}

	moved, err := set.SetFolder(FolderRequest{Id: "c", Folder: "/clients/other"})
	if err != nil || of(moved, "w1") != "/clients/other" {
		t.Fatalf("replacing the folder: %v %q", err, of(moved, "w1"))
	}

	cleared, err := set.SetFolder(FolderRequest{Id: "c", Folder: ""})
	if err != nil || of(cleared, "w1") != "" {
		t.Fatalf("clearing the folder: %v %q", err, of(cleared, "w1"))
	}
	if blank, err := set.SetFolder(FolderRequest{Id: "c", Folder: "  "}); err != nil || of(blank, "w1") != "" {
		t.Fatalf("a blank folder clears it: %v %q", err, of(blank, "w1"))
	}
	if entry, _ := MetaValue(cleared.Contexts)[1].(map[string]any); entry == nil || entry["folder"] != nil {
		t.Fatalf("a cleared folder is still stored: %+v", entry)
	}

	if _, err := s.SetFolder(FolderRequest{Id: "c", Folder: "sefers"}); err == nil {
		t.Fatalf("a relative folder was taken")
	}
	if _, err := s.SetFolder(FolderRequest{Id: "ghost", Folder: "/x"}); err == nil {
		t.Fatalf("a context that does not exist took a folder")
	}
}

// A text standing for the resolution of symbolic links: each link's path begins with its key.
func fakeResolve(links map[string]string) func(string) (string, error) {
	return func(path string) (string, error) {
		path = filepath.Clean(path)
		for from, to := range links {
			if path == from || strings.HasPrefix(path, from+"/") {
				return to + strings.TrimPrefix(path, from), nil
			}
		}
		return path, nil
	}
}

// #2518: a workspace folder outside its context's folder asks for the confirmation. The folders are cleaned and
// resolved before they are compared, so neither a shared prefix, a trailing separator, a parent step nor a symbolic link
// changes the answer.
func TestCheckFolderTellsWhichWorkspaceFoldersNeedTheConfirmation(t *testing.T) {
	s, _ := mustCreate(t, MakeState(nil, workspaces("w1", "w2")), "Client", "c", "w1")
	s, err := s.SetFolder(FolderRequest{Id: "c", Folder: "/clients/sefers"})
	if err != nil {
		t.Fatal(err)
	}
	links := map[string]string{
		"/clients/sefers/shared": "/archive/shared",
		"/fast":                  "/clients/sefers",
		"/clients/sefers/back":   "/clients",
	}
	cases := []struct {
		name    string
		req     FolderCheckRequest
		outside bool
	}{
		{"the context's own folder", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers"}, false},
		{"inside", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/app/src"}, false},
		{"inside with a trailing separator", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/app/"}, false},
		{"a sibling sharing the prefix", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers2"}, true},
		{"a sibling sharing the prefix, trailing separator", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers-old/"}, true},
		{"the parent", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients"}, true},
		{"leaving through a parent step", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/../other"}, true},
		{"a link inside that points outside", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/shared/x"}, true},
		{"a link inside that points to the parent", FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/back"}, true},
		{"a folder reached from outside through a link", FolderCheckRequest{WorkspaceId: "w1", Folder: "/fast/app"}, false},
		{"asked by context", FolderCheckRequest{ContextId: "c", Folder: "/home/me"}, true},
		{"asked by context, inside", FolderCheckRequest{ContextId: "c", Folder: "/clients/sefers/x"}, false},
		{"a workspace of a context without a folder", FolderCheckRequest{WorkspaceId: "w2", Folder: "/home/me"}, false},
		{"no folder chosen", FolderCheckRequest{WorkspaceId: "w1", Folder: ""}, false},
	}
	for _, tc := range cases {
		got, err := s.CheckFolder(tc.req, fakeResolve(links))
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if got.Outside != tc.outside {
			t.Errorf("%s: outside %v, want %v (%+v)", tc.name, got.Outside, tc.outside, got)
		}
	}

	got, err := s.CheckFolder(FolderCheckRequest{WorkspaceId: "w1", Folder: "/fast/app"}, fakeResolve(links))
	if err != nil || got.Folder != "/clients/sefers/app" || got.ContextFolder != "/clients/sefers" {
		t.Errorf("the answer names the folders as resolved: %v %+v", err, got)
	}
	if got, _ := s.CheckFolder(FolderCheckRequest{WorkspaceId: "w2", Folder: "/home/me"}, nil); got.ContextFolder != "" {
		t.Errorf("a context without a folder named %q", got.ContextFolder)
	}
	if got, err := s.CheckFolder(FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers2"}, nil); err != nil || !got.Outside {
		t.Errorf("without a resolver the paths are compared as written: %v %+v", err, got)
	}
}

func TestCheckFolderRefusesWhatItCannotPlace(t *testing.T) {
	s, _ := mustCreate(t, MakeState(nil, workspaces("w1")), "Client", "c", "w1")
	s, err := s.SetFolder(FolderRequest{Id: "c", Folder: "/clients/sefers"})
	if err != nil {
		t.Fatal(err)
	}
	for name, req := range map[string]FolderCheckRequest{
		"neither a workspace nor a context": {Folder: "/x"},
		"a workspace that does not exist":   {WorkspaceId: "ghost", Folder: "/x"},
		"a context that does not exist":     {ContextId: "ghost", Folder: "/x"},
		"a relative folder":                 {WorkspaceId: "w1", Folder: "sefers/app"},
	} {
		if _, err := s.CheckFolder(req, nil); err == nil {
			t.Errorf("%s was answered", name)
		}
	}
}

// A folder that cannot be resolved is not a reason to block: it asks, like a file panel's path that cannot be resolved.
func TestCheckFolderAsksWhenAFolderCannotBeResolved(t *testing.T) {
	s, _ := mustCreate(t, MakeState(nil, workspaces("w1")), "Client", "c", "w1")
	s, err := s.SetFolder(FolderRequest{Id: "c", Folder: "/clients/sefers"})
	if err != nil {
		t.Fatal(err)
	}
	broken := func(path string) (string, error) {
		if strings.HasSuffix(path, "/broken") {
			return "", errors.New("permission denied")
		}
		return path, nil
	}
	got, err := s.CheckFolder(FolderCheckRequest{WorkspaceId: "w1", Folder: "/clients/sefers/broken"}, broken)
	if err != nil || !got.Outside || got.Error == "" {
		t.Fatalf("an unresolvable folder: %v %+v", err, got)
	}
}
