// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

func mustCode(t *testing.T, err error, code string, english string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want %s", code)
	}
	if got := uimsg.TextOf(err); got == nil || got.Code != code {
		t.Fatalf("%q carries %+v, want the code %s", err, got, code)
	}
	if err.Error() != english {
		t.Fatalf("the English changed: %q, want %q", err.Error(), english)
	}
}

// #656: the Review tab gets the code of what the service refused; `molten review` and the logs keep the English.
func TestWindowsGetTheServiceCodes(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{service: &Service{store: MakeStore(t.TempDir())}}).route())
	if err != nil {
		t.Fatal(err)
	}
	head := strings.Repeat("a", 40)
	req := map[string]any{"repo": testRepo, "number": 7, "text": "  ", "subject": SubjectLine,
		"anchor": map[string]any{"path": "a.go", "side": mcpreview.SideRight, "startline": 1, "line": 1, "headoid": head, "excerpt": "x"}}
	_, errStr := routetest.Ask(t, link, e.Window(), CommentCommand, req)
	text, english := uimsg.Unwire(errStr)
	if text == nil || text.Code != "review.commentempty" || english != "the comment is empty" {
		t.Fatalf("the window got %q", errStr)
	}
}

func TestCommentRefusalsCarryCodes(t *testing.T) {
	s := MakeStore(t.TempDir())
	k := PrKey{Repo: "o/r", Number: 3}
	head := strings.Repeat("a", 40)
	_, _, err := s.SaveComment(CommentRequest{PrKey: k, Id: "nope", Text: "x"})
	mustCode(t, err, "review.nocomment", "no comment has the id nope")
	state, _, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, mcpreview.SideRight, 0, 1, "x"), Subject: SubjectLine, Text: "t"})
	if err != nil {
		t.Fatal(err)
	}
	id := state.Comments[0].Id
	_, _, err = s.SetCommentState(CommentStateRequest{PrKey: k, Id: id, Action: ActionUnstage})
	mustCode(t, err, "review.notstaged", "this comment is not staged")
	if _, _, err := s.SetCommentState(CommentStateRequest{PrKey: k, Id: id, Action: ActionDrop}); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.SaveComment(CommentRequest{PrKey: k, Id: id, Text: "changed"})
	mustCode(t, err, "review.commentdropped", "this comment is dropped: it cannot be changed")
	_, _, err = s.SetCommentState(CommentStateRequest{PrKey: k, Id: id, Action: ActionDrop})
	mustCode(t, err, "review.alreadydropped", "this comment is already dropped")
}

func TestDiscussWithoutSessionCarriesItsCode(t *testing.T) {
	store := MakeStore(t.TempDir())
	k := PrKey{Repo: "o/r", Number: 3}
	state, _, err := store.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(strings.Repeat("a", 40), mcpreview.SideRight, 0, 1, "x"), Subject: SubjectLine, Text: "t"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{store: store}
	_, err = s.Discuss(t.Context(), DiscussRequest{PrKey: k, Id: state.Comments[0].Id})
	mustCode(t, err, "review.nosession", "MoltenTerm cannot reach the review session")
}

func TestPublishRecordCarriesItsCode(t *testing.T) {
	f := makePublishFixture(t)
	a := f.comment(SubjectFile, 3, "Un")
	f.translate(a, "One")
	f.gh.failFileComments = 1
	state, err := f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if got := state.Publish.MessageText; got == nil || got.Code != "review.someunposted" {
		t.Fatalf("the partial record carries %+v", got)
	}
	if !strings.HasPrefix(state.Publish.Message, "Some comments could not be posted") {
		t.Fatalf("the English changed: %q", state.Publish.Message)
	}
}
