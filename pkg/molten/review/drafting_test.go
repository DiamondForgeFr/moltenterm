// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func events(c Comment) string {
	var rtn []string
	for _, e := range c.History {
		rtn = append(rtn, e.Event+":"+e.State)
	}
	return strings.Join(rtn, ",")
}

// FR-REV-009 AC1: a draft is staged, unstaged, dropped and restored; each step is in its history (AC5).
func TestCommentActions(t *testing.T) {
	s := MakeStore(t.TempDir())
	k := PrKey{Repo: "o/r", Number: 4}
	head := strings.Repeat("b", 40)
	state, _, err := s.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, mcpreview.SideRight, 0, 2, "x"), Subject: SubjectLine, Text: "À renommer", Kind: CommentKindChange})
	if err != nil {
		t.Fatal(err)
	}
	id := state.Comments[0].Id
	act := func(action string) (State, error) {
		st, _, err := s.SetCommentState(CommentStateRequest{PrKey: k, Id: id, Action: action})
		return st, err
	}
	for _, bad := range []string{ActionUnstage, ActionRestore, ActionAccept, "publish"} {
		if _, err := act(bad); err == nil {
			t.Errorf("%s on a draft was taken", bad)
		}
	}
	if st, err := act(ActionStage); err != nil || st.Comments[0].State != CommentStateStaged {
		t.Fatalf("stage %v %+v", err, st.Comments)
	}
	if n, _ := s.Unpublished(k); n != 1 {
		t.Errorf("unpublished %d", n)
	}
	s.update(k, func(st *State) bool {
		st.Comments[0].State = CommentStateTranslated
		st.Comments[0].Translation = &CommentText{Lang: "en", Text: "To rename"}
		return true
	})
	if st, err := act(ActionUnstage); err != nil || st.Comments[0].State != CommentStateDraft {
		t.Fatalf("unstage %v %+v", err, st.Comments)
	}
	act(ActionDrop)
	if n, _ := s.Unpublished(k); n != 0 {
		t.Errorf("a dropped comment is unpublished: %d", n)
	}
	st, err := act(ActionRestore)
	if err != nil || st.Comments[0].State != CommentStateDraft {
		t.Fatalf("restore %v %+v", err, st.Comments)
	}
	if got := events(st.Comments[0]); got != "created:draft,staged:staged,unstaged:draft,dropped:dropped,restored:draft" {
		t.Errorf("history %s", got)
	}
	if st.Comments[0].History[0].Text != "À renommer" || st.Comments[0].History[0].Kind != CommentKindChange {
		t.Errorf("original %+v", st.Comments[0].History[0])
	}
	if _, _, err := s.SetCommentState(CommentStateRequest{PrKey: k, Id: "nope", Action: ActionStage}); err == nil {
		t.Error("a missing comment was staged")
	}
	// A kind change alone keeps the translation and says so in the history.
	s.SetCommentState(CommentStateRequest{PrKey: k, Id: id, Action: ActionStage})
	s.update(k, func(st *State) bool { st.Comments[0].Translation = &CommentText{Text: "x"}; return true })
	st, _, _ = s.SaveComment(CommentRequest{PrKey: k, Id: id, Text: "À renommer", Kind: CommentKindComment})
	if st.Comments[0].Translation == nil || st.Comments[0].History[len(st.Comments[0].History)-1].Event != EventKind {
		t.Errorf("kind change %+v", st.Comments[0])
	}
}

func TestHistoryKeepsTheOriginal(t *testing.T) {
	c := Comment{State: CommentStateDraft}
	addEvent(&c, 1, EventCreated, AuthorDeveloper, "original")
	for i := 0; i < maxHistory+20; i++ {
		addEvent(&c, int64(i+2), EventEdited, AuthorDeveloper, "edit")
	}
	if len(c.History) != maxHistory || c.History[0].Text != "original" || c.History[len(c.History)-1].At != int64(maxHistory+21) {
		t.Errorf("history %d %+v %+v", len(c.History), c.History[0], c.History[len(c.History)-1])
	}
}

// FR-REV-009 AC3: the agent's proposal is a proposal until the developer accepts it; then it is a staged comment.
func TestProposals(t *testing.T) {
	svc := MakeService(t.TempDir(), execGit, nil)
	k := PrKey{Repo: "o/r", Number: 5}
	head := strings.Repeat("c", 40)
	post := mcpreview.Post{
		Id: "e3", Kind: mcpreview.PostProposal, At: 100, Text: " Nommer la constante ", CommentKind: mcpreview.KindChange,
		Anchor: &mcpreview.Anchor{Path: "a.go", Side: mcpreview.SideRight, Line: 7, Excerpt: "x := 3"}, HeadOid: head,
		Subject: SubjectFile, Lang: "fr",
	}
	svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &post})
	state, _ := svc.store.Get(k)
	if len(state.Comments) != 1 {
		t.Fatalf("comments %+v", state.Comments)
	}
	c := state.Comments[0]
	if c.State != CommentStateProposed || c.Author != AuthorAgent || c.Kind != CommentKindChange || c.Subject != SubjectFile ||
		c.Anchor.HeadOid != head || c.Original != (CommentText{Lang: "fr", Text: "Nommer la constante"}) || events(c) != "proposed:proposed" {
		t.Errorf("proposal %+v", c)
	}
	if n, _ := svc.store.Unpublished(k); n != 0 {
		t.Errorf("a proposal counts as unpublished: %d", n)
	}
	if _, _, err := svc.store.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionStage}); err == nil {
		t.Error("a proposal was staged without being accepted")
	}
	state, _, _ = svc.store.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionDrop})
	state, _, _ = svc.store.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionRestore})
	if state.Comments[0].State != CommentStateProposed {
		t.Errorf("a restored proposal is %s", state.Comments[0].State)
	}
	state, _, err := svc.store.SetCommentState(CommentStateRequest{PrKey: k, Id: c.Id, Action: ActionAccept})
	if err != nil || state.Comments[0].State != CommentStateStaged || state.Comments[0].Author != AuthorAcceptedProposal {
		t.Errorf("accept %v %+v", err, state.Comments[0])
	}
	bad := post
	bad.Anchor = nil
	if _, _, err := svc.store.AddProposal(k, bad); err == nil {
		t.Error("a proposal without anchor was kept")
	}
	bad = post
	bad.HeadOid = ""
	if _, _, err := svc.store.AddProposal(k, bad); err == nil {
		t.Error("a proposal without head was kept")
	}
}

// FR-REV-009 AC2: Discuss reaches the session with the comment and its lines; the reply is kept under the comment and
// its rewrite is used or ignored.
func TestDiscussAndReply(t *testing.T) {
	svc := MakeService(t.TempDir(), execGit, nil)
	k := PrKey{Repo: "o/r", Number: 6}
	head := strings.Repeat("d", 40)
	state, _, _ := svc.store.SaveComment(CommentRequest{PrKey: k, Anchor: anchorOn(head, mcpreview.SideRight, 3, 4, "a\nb"), Subject: SubjectLine, Text: "Pourquoi deux appels ?", Lang: "fr"})
	id := state.Comments[0].Id
	ctx := context.Background()
	if _, err := svc.Discuss(ctx, DiscussRequest{PrKey: k, Id: id}); err == nil {
		t.Error("discussed without a session")
	}
	var got []mcpreview.DiscussRequest
	busy := true
	svc.discuss = func(ctx context.Context, req mcpreview.DiscussRequest) (mcpreview.AskResult, error) {
		got = append(got, req)
		if busy {
			return mcpreview.AskResult{Busy: true, Message: "working"}, nil
		}
		return mcpreview.AskResult{Sent: true, Submitted: true}, nil
	}
	res, err := svc.Discuss(ctx, DiscussRequest{PrKey: k, Id: id, Message: " Est-ce clair ? "})
	if err != nil || res.Sent || !res.Busy || res.State != nil {
		t.Fatalf("busy %v %+v", err, res)
	}
	busy = false
	res, err = svc.Discuss(ctx, DiscussRequest{PrKey: k, Id: id, Message: " Est-ce clair ? "})
	if err != nil || !res.Sent || res.State == nil || len(res.State.Comments[0].Discussion) != 1 {
		t.Fatalf("sent %v %+v", err, res)
	}
	req := got[1]
	if req.Repo != k.Repo || req.Number != k.Number || req.Comment.Id != id || req.Comment.Text != "Pourquoi deux appels ?" ||
		req.Comment.Kind != CommentKindComment || req.Anchor.StartLine != 3 || req.Anchor.Excerpt != "a\nb" || req.Message != "Est-ce clair ?" {
		t.Errorf("request %+v", req)
	}
	if m := res.State.Comments[0].Discussion[0]; m.By != MessageByDeveloper || m.Text != "Est-ce clair ?" {
		t.Errorf("developer message %+v", m)
	}

	reply := mcpreview.Post{Id: "e4", Kind: mcpreview.PostReply, At: 200, CommentId: id, Markdown: "Oui, **mais**…", Text: "Pourquoi appeler deux fois `load` ?", Agent: "claude"}
	svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &reply})
	state, _ = svc.store.Get(k)
	msg := state.Comments[0].Discussion[1]
	if msg.By != MessageByAgent || msg.Text != "Oui, **mais**…" || msg.Rewrite != "Pourquoi appeler deux fois `load` ?" || msg.RewriteState != RewriteProposed || msg.Agent != "claude" {
		t.Fatalf("reply %+v", msg)
	}
	state, _, err = svc.store.UseRewrite(RewriteRequest{PrKey: k, Id: id, MessageId: msg.Id, Accept: true})
	c := state.Comments[0]
	if err != nil || c.Original.Text != "Pourquoi appeler deux fois `load` ?" || c.Discussion[1].RewriteState != RewriteAccepted ||
		c.History[len(c.History)-1].Event != EventRewritten || c.History[0].Text != "Pourquoi deux appels ?" {
		t.Errorf("rewrite %v %+v", err, c)
	}
	if _, _, err := svc.store.UseRewrite(RewriteRequest{PrKey: k, Id: id, MessageId: msg.Id, Accept: true}); err == nil {
		t.Error("a rewrite was used twice")
	}
	// A reply without rewrite (or repeating the text) offers none; another rewrite is ignored.
	plain := reply
	plain.Text = c.Original.Text
	svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &plain})
	other := reply
	other.Text = "Autre version"
	svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &other})
	state, _ = svc.store.Get(k)
	d := state.Comments[0].Discussion
	if len(d) != 4 || d[2].Rewrite != "" || d[3].RewriteState != RewriteProposed {
		t.Fatalf("discussion %+v", d)
	}
	state, _, err = svc.store.UseRewrite(RewriteRequest{PrKey: k, Id: id, MessageId: d[3].Id})
	if err != nil || state.Comments[0].Discussion[3].RewriteState != RewriteIgnored || state.Comments[0].Original.Text == "Autre version" {
		t.Errorf("ignore %v %+v", err, state.Comments[0])
	}
	// Published: no more discussion, and a late reply is not kept.
	svc.store.update(k, func(st *State) bool { st.Comments[0].State = CommentStatePublished; return true })
	if _, err := svc.Discuss(ctx, DiscussRequest{PrKey: k, Id: id}); err == nil {
		t.Error("a published comment was discussed")
	}
	svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &reply})
	if state, _ = svc.store.Get(k); len(state.Comments[0].Discussion) != 4 {
		t.Errorf("a reply on a published comment was kept")
	}
}
