// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func TestParseHunksAndInHunk(t *testing.T) {
	out := "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,6 +1,8 @@ func A\n a\n+b\n@@ -20 +22,0 @@\n-x\n @@ not a header\n"
	hunks := ParseHunks([]byte(out))
	want := []Hunk{{OldStart: 1, OldLines: 6, NewStart: 1, NewLines: 8}, {OldStart: 20, OldLines: 1, NewStart: 22, NewLines: 0}}
	if fmt.Sprint(hunks) != fmt.Sprint(want) {
		t.Fatalf("hunks %+v", hunks)
	}
	cases := []struct {
		side       string
		start, end int
		in         bool
	}{
		{mcpreview.SideRight, 2, 8, true},
		{mcpreview.SideRight, 8, 9, false},
		{mcpreview.SideRight, 0, 3, true},
		{mcpreview.SideRight, 22, 22, false},
		{mcpreview.SideLeft, 20, 20, true},
		{mcpreview.SideLeft, 6, 20, false},
	}
	for _, c := range cases {
		if got := InHunk(hunks, c.side, c.start, c.end); got != c.in {
			t.Errorf("%s %d-%d: %v", c.side, c.start, c.end, got)
		}
	}
}

func TestFindExcerpt(t *testing.T) {
	text := "a\nb\nc\nx\ny\nz\nx\ny\n"
	if s, e, ok := FindExcerpt(text, "x\ny\n", 6); !ok || s != 7 || e != 8 {
		t.Errorf("nearest: %d %d %v", s, e, ok)
	}
	if s, e, ok := FindExcerpt(text, "x  \r\ny", 1); !ok || s != 4 || e != 5 {
		t.Errorf("trailing space: %d %d %v", s, e, ok)
	}
	if _, _, ok := FindExcerpt(text, "q", 1); ok {
		t.Error("found a missing line")
	}
	if _, _, ok := FindExcerpt(text, "  \n", 1); ok {
		t.Error("an empty excerpt is found nowhere")
	}
}

func anchorOn(head string, side string, start int, line int, excerpt string) *mcpreview.Anchor {
	return &mcpreview.Anchor{Path: "change.go", Side: side, StartLine: start, Line: line, HeadOid: head, Excerpt: excerpt}
}

// FR-REV-003 AC3: a comment is saved as a draft with its anchor; its text can change until it is published. FR-REV-009
// AC5: dropping keeps it, with its history.
func TestSaveAndDropComment(t *testing.T) {
	s := MakeStore(t.TempDir())
	k := PrKey{Repo: "o/r", Number: 3}
	head := strings.Repeat("a", 40)
	if _, _, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, "UP", 0, 1, "x"), Subject: SubjectLine, Text: "t"}); err == nil {
		t.Error("a bad side was taken")
	}
	if _, _, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn("", mcpreview.SideRight, 0, 1, "x"), Subject: SubjectLine, Text: "t"}); err == nil {
		t.Error("an anchor without its head was taken")
	}
	if _, _, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, mcpreview.SideRight, 0, 1, "x"), Subject: SubjectLine, Text: "  "}); err == nil {
		t.Error("an empty comment was taken")
	}
	state, changed, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, mcpreview.SideRight, 2, 4, "x"), Subject: SubjectLine, Text: " Pourquoi ? ", Lang: "fr"})
	if err != nil || !changed || len(state.Comments) != 1 {
		t.Fatalf("save %v %+v", err, state)
	}
	c := state.Comments[0]
	if c.State != CommentStateDraft || c.Kind != CommentKindComment || c.Author != AuthorDeveloper || c.Original != (CommentText{Lang: "fr", Text: "Pourquoi ?"}) || c.Anchor.StartLine != 2 || c.Id == "" {
		t.Errorf("comment %+v", c)
	}
	state, changed, err = s.SaveComment(CommentRequest{PrKey: k, Id: c.Id, Text: "Pourquoi ce choix ?", Kind: CommentKindChange})
	if err != nil || !changed || state.Comments[0].Original.Text != "Pourquoi ce choix ?" || state.Comments[0].Kind != CommentKindChange || state.Comments[0].Anchor.Line != 4 {
		t.Errorf("edit %v %+v", err, state.Comments)
	}
	if _, _, err := s.SaveComment(CommentRequest{PrKey: k, Id: "nope", Text: "x"}); err == nil {
		t.Error("edited a missing comment")
	}
	s.update(k, func(st *State) bool { st.Comments[0].State = CommentStatePublished; return true })
	if _, _, err := s.SaveComment(CommentRequest{PrKey: k, Id: c.Id, Text: "x"}); err == nil {
		t.Error("a published comment was changed")
	}
	if _, _, err := s.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionDrop}); err == nil {
		t.Error("a published comment was dropped")
	}
	s.update(k, func(st *State) bool { st.Comments[0].State = CommentStateDraft; return true })
	state, changed, err = s.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionDrop})
	if err != nil || !changed || len(state.Comments) != 1 || state.Comments[0].State != CommentStateDropped {
		t.Errorf("drop %v %+v", err, state.Comments)
	}
	h := state.Comments[0].History
	if len(h) != 3 || h[0].Event != EventCreated || h[0].Text != "Pourquoi ?" || h[1].Event != EventEdited ||
		h[1].Text != "Pourquoi ce choix ?" || h[1].Kind != CommentKindChange || h[2].Event != EventDropped || h[2].State != CommentStateDropped {
		t.Errorf("history %+v", h)
	}
}

// FR-REV-003 AC5: after a push, an anchor moves with its lines, or is outdated with its excerpt.
func TestRelocate(t *testing.T) {
	fx := makeFixture(t)
	ctx := context.Background()
	svc := MakeService(t.TempDir(), execGit, nil)
	d := svc.differ
	req := FilesRequest{Dir: fx.dir, HeadRef: "feature/1-x", BaseRef: "develop", HeadOid: fx.head, BaseOid: fx.base}
	files, err := d.Files(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	k := PrKey{Repo: "o/r", Number: 1}
	// change.go at the head: "package change\n\nfunc A() {}\n\nfunc B() {}\n"; the PR added lines 4-5.
	save := func(a *mcpreview.Anchor, subject string) {
		if _, _, err := svc.store.SaveComment(CommentRequest{PrKey: k, Anchor: a, Subject: subject, Text: "c"}); err != nil {
			t.Fatal(err)
		}
	}
	save(anchorOn(fx.head, mcpreview.SideRight, 0, 5, "func B() {}"), SubjectLine)
	save(anchorOn(fx.head, mcpreview.SideRight, 0, 1, "package change"), SubjectLine)
	save(anchorOn(fx.head, mcpreview.SideLeft, 0, 3, "func A() {}"), SubjectLine)
	save(anchorOn(fx.head, mcpreview.SideRight, 0, 5, "func B() {}"), SubjectFile)
	save(anchorOn(fx.head, mcpreview.SideRight, 0, 5, "func B() {}"), SubjectLine)

	file := FileRequest{Dir: fx.dir, Path: "change.go"}
	for _, f := range files.Files {
		if f.Path == "change.go" {
			file.OldBlob, file.NewBlob = f.OldBlob, f.NewBlob
		}
	}
	got, err := d.File(ctx, file)
	if err != nil || len(got.Hunks) != 1 || !InHunk(got.Hunks, mcpreview.SideRight, 4, 5) || InHunk(got.Hunks, mcpreview.SideRight, 6, 6) {
		t.Fatalf("hunks %v %+v", err, got.Hunks)
	}

	// The new push puts ten lines above B, removes it from the PR in a second file, and edits the fifth comment's line.
	runGit(t, fx.dir, "checkout", "-q", "feature/1-x")
	write(t, fx.dir, "change.go", "package change\n\nfunc A() {}\n\n"+strings.Repeat("// pad\n", 10)+"\nfunc B() {}\n")
	runGit(t, fx.dir, "commit", "-q", "-am", "push 2")
	newHead := runGit(t, fx.dir, "rev-parse", "HEAD")
	svc.store.update(k, func(st *State) bool { st.Comments[4].Anchor.Excerpt = "func C() {}"; return true })
	state, changed, err := svc.Relocate(ctx, RelocateRequest{PrKey: k, Dir: fx.dir, HeadOid: newHead, BaseOid: files.BaseOid})
	if err != nil || !changed {
		t.Fatalf("relocate %v %v", err, changed)
	}
	c := state.Comments
	if c[0].Anchor.Line != 16 || c[0].Anchor.HeadOid != newHead || c[0].Subject != SubjectLine || c[0].Outdated {
		t.Errorf("moved: %+v", c[0])
	}
	// Line 1 did not move and is still within three lines of the change.
	if c[1].Anchor.Line != 1 || c[1].Subject != SubjectLine || c[1].Outdated || c[1].Anchor.HeadOid != newHead {
		t.Errorf("unmoved: %+v", c[1])
	}
	if c[2].Anchor.Side != mcpreview.SideLeft || c[2].Anchor.Line != 3 || c[2].Anchor.HeadOid != newHead {
		t.Errorf("base side: %+v", c[2])
	}
	if c[3].Subject != SubjectFile || c[3].Anchor.Line != 16 {
		t.Errorf("file-level: %+v", c[3])
	}
	if !c[4].Outdated || c[4].Anchor.Line != 5 || c[4].Anchor.HeadOid != fx.head || c[4].Anchor.Excerpt != "func C() {}" {
		t.Errorf("outdated: %+v", c[4])
	}
	if _, changed, _ := svc.Relocate(ctx, RelocateRequest{PrKey: k, Dir: fx.dir, HeadOid: newHead, BaseOid: files.BaseOid}); changed {
		t.Error("a second relocation changed something")
	}
}
