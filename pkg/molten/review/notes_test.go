// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func keptNotesService(t *testing.T, git func(ctx context.Context, dir string, args ...string) ([]byte, error)) (*Service, string, []Notes) {
	dataDir := t.TempDir()
	svc := MakeService(dataDir, git, func(k PrKey, state State) {})
	published := []Notes{}
	svc.publishNotes = func(notes Notes) { published = append(published, notes) }
	return svc, dataDir, published
}

// FR-REV-008 AC1, AC3, AC4: an answer is kept as a note copied from the review store, with its title (the technique),
// text, principles, sources, PR and anchor, in MoltenTerm's data folder; it can be renamed and deleted.
func TestKeepRenameDeleteNote(t *testing.T) {
	svc, dataDir, _ := keptNotesService(t, nil)
	k := PrKey{Repo: "Owner/Repo", Number: 7}
	anchor := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 5, HeadOid: testHead}
	if _, _, err := svc.store.SetExplanation(k, Explanation{
		Id: "e1", Question: "why?", Technique: "defer-unlock helper", Markdown: "Because.", Anchor: anchor,
		Principles: []string{"KISS"}, Sources: []string{"main.go:4"}, Related: []string{"x.go:2"}, HeadOid: testHead, At: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.store.SetExplanation(k, Explanation{Id: "e2", Markdown: "## Summary\nThe PR…", At: 11}); err != nil {
		t.Fatal(err)
	}
	keep := NoteKeepRequest{PrKey: k, ExplanationId: "e1", PrTitle: "Locks", PrUrl: "https://github.com/Owner/Repo/pull/7", BaseRef: "develop"}
	notes, err := svc.notesChanged(svc.store.KeepNote(keep))
	if err != nil || len(notes.Notes) != 1 {
		t.Fatalf("keep: %+v %v", notes, err)
	}
	n := notes.Notes[0]
	if n.Title != "defer-unlock helper" || n.Markdown != "Because." || n.Question != "why?" || n.Anchor == nil ||
		n.Anchor.Line != 5 || n.Pr.Number != 7 || n.Pr.Title != "Locks" || n.Pr.BaseRef != "develop" ||
		n.HeadOid != testHead || len(n.Principles) != 1 || len(n.Sources) != 1 || len(n.Related) != 1 || n.KeptAt == 0 {
		t.Errorf("note %+v", n)
	}
	if again, changed, err := svc.store.KeepNote(keep); err != nil || changed || len(again.Notes) != 1 {
		t.Errorf("keeping twice: %+v %v %v", again, changed, err)
	}
	notes, _, err = svc.store.KeepNote(NoteKeepRequest{PrKey: k, ExplanationId: "e2"})
	if err != nil || len(notes.Notes) != 2 || notes.Notes[1].Title != "Summary" {
		t.Errorf("default title from the text: %+v %v", notes, err)
	}
	if _, _, err := svc.store.KeepNote(NoteKeepRequest{PrKey: k, ExplanationId: "nope"}); err == nil {
		t.Error("an unknown answer was kept")
	}
	file := filepath.Join(dataDir, "molten", "reviews", "owner__repo", "notes.json")
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the notes are not in the data folder: %v", err)
	}

	notes, err = svc.notesChanged(svc.store.RenameNote(NoteRenameRequest{Repo: k.Repo, Id: n.Id, Title: "  Lock   helpers "}))
	if err != nil || notes.Notes[0].Title != "Lock helpers" || notes.Notes[0].UpdatedAt == 0 {
		t.Errorf("rename: %+v %v", notes, err)
	}
	if _, _, err := svc.store.RenameNote(NoteRenameRequest{Repo: k.Repo, Id: n.Id, Title: " "}); err == nil {
		t.Error("an empty title was kept")
	}
	if _, _, err := svc.store.RenameNote(NoteRenameRequest{Repo: k.Repo, Id: "nope", Title: "x"}); err == nil {
		t.Error("an unknown note was renamed")
	}
	notes, err = svc.notesChanged(svc.store.DeleteNote(NoteDeleteRequest{Repo: k.Repo, Id: n.Id}))
	if err != nil || len(notes.Notes) != 1 || notes.Notes[0].Id == n.Id {
		t.Errorf("delete: %+v %v", notes, err)
	}
	if got, err := MakeStore(dataDir).GetNotes("owner/repo"); err != nil || len(got.Notes) != 1 {
		t.Errorf("read again: %+v %v", got, err)
	}
}

// AC3: the notes outlive the PR: its review store going, its explanations rolling over, nothing prunes them.
func TestNotesOutliveThePr(t *testing.T) {
	svc, dataDir, _ := keptNotesService(t, nil)
	k := PrKey{Repo: "o/r", Number: 3}
	if _, _, err := svc.store.SetExplanation(k, Explanation{Id: "e1", Markdown: "text", At: 1}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.store.KeepNote(NoteKeepRequest{PrKey: k, ExplanationId: "e1"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(svc.store.fileOf(k)); err != nil {
		t.Fatal(err)
	}
	notes, err := MakeStore(dataDir).GetNotes("o/r")
	if err != nil || len(notes.Notes) != 1 || notes.Notes[0].Markdown != "text" {
		t.Errorf("notes after the PR's store went: %+v %v", notes, err)
	}
}

// A notes file that does not read is reported, never overwritten.
func TestUnreadableNotesKept(t *testing.T) {
	svc, _, _ := keptNotesService(t, nil)
	file := svc.store.notesFile("o/r")
	os.MkdirAll(filepath.Dir(file), 0700)
	os.WriteFile(file, []byte("{not json"), 0600)
	if _, _, err := svc.store.DeleteNote(NoteDeleteRequest{Repo: "o/r", Id: "x"}); err == nil {
		t.Error("an unreadable notes file was accepted")
	}
	if data, _ := os.ReadFile(file); string(data) != "{not json" {
		t.Errorf("the notes file was replaced: %q", data)
	}
}

// AC2: a note's link reads the file from the project's git, at the merged commit, else the answer's head, else the
// base branch, and never from the PR's worktree.
func TestNoteFileAfterMerge(t *testing.T) {
	fx := makeFixture(t)
	svc, dataDir, _ := keptNotesService(t, execGit)
	ctx := context.Background()
	k := PrKey{Repo: "o/r", Number: 1}
	if _, _, err := svc.store.SetExplanation(k, Explanation{Id: "e1", Markdown: "B", HeadOid: fx.head, At: 1}); err != nil {
		t.Fatal(err)
	}
	notes, _, err := svc.store.KeepNote(NoteKeepRequest{PrKey: k, ExplanationId: "e1", BaseRef: "develop"})
	if err != nil {
		t.Fatal(err)
	}
	id := notes.Notes[0].Id
	open := func(p string) (NoteFileResult, string) {
		t.Helper()
		res, err := svc.NoteFile(ctx, NoteFileRequest{Repo: k.Repo, Id: id, Dir: fx.dir, Path: p})
		if err != nil {
			return res, err.Error()
		}
		return res, ""
	}

	res, msg := open("./change.go")
	if msg != "" || res.From != NoteFromHead || res.Commit != fx.head {
		t.Fatalf("head: %+v %s", res, msg)
	}
	if !strings.HasPrefix(res.File, filepath.Join(dataDir, "molten", "reviews", "o__r", "notes-files", fx.head)) {
		t.Errorf("snapshot outside the data folder: %s", res.File)
	}
	if data, _ := os.ReadFile(res.File); !strings.Contains(string(data), "func B()") {
		t.Errorf("snapshot content %q", data)
	}
	if info, _ := os.Stat(res.File); info.Mode().Perm()&0200 != 0 {
		t.Errorf("snapshot is writable: %v", info.Mode())
	}
	if again, msg := open("change.go"); msg != "" || again.File != res.File {
		t.Errorf("second open: %+v %s", again, msg)
	}
	// A file the head deleted is read from the base branch.
	if res, msg := open("gone.txt"); msg != "" || res.From != NoteFromBase || res.Commit != fx.base {
		t.Errorf("base: %+v %s", res, msg)
	}

	// The PR merged: its merged commit comes first.
	if _, _, err := svc.store.SetMerge(k, MergeRecord{State: MergeMerged, MergedOid: fx.base}); err != nil {
		t.Fatal(err)
	}
	if res, msg := open("later.go"); msg != "" || res.From != NoteFromMerged || res.Commit != fx.base {
		t.Errorf("merged: %+v %s", res, msg)
	}
	if res, msg := open("move/new.ts"); msg != "" || res.From != NoteFromHead {
		t.Errorf("a file the merged commit lacks: %+v %s", res, msg)
	}

	for _, p := range []string{"../outside.go", "/etc/passwd", "a/../../b", "", "-p"} {
		if _, msg := open(p); msg == "" {
			t.Errorf("%q was read", p)
		}
	}
	if _, msg := open("missing.go"); msg == "" {
		t.Error("a missing file was opened")
	}
}
