// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestDiscussLine(t *testing.T) {
	anchor := &mcpreview.Anchor{Path: "pkg/a.go", Side: mcpreview.SideRight, StartLine: 3, Line: 4}
	comment := mcpreview.CommentRef{Id: "c1", Kind: mcpreview.KindChange, Text: "Renommer"}
	got := DiscussLine(anchor, comment, "Est-ce\n trop sec ?")
	want := "Review comment c1 (a change request) on pkg/a.go, head side, lines 3-4 (review_selection has it): Est-ce trop sec ?"
	if got != want {
		t.Errorf("got %q", got)
	}
	comment.Kind = mcpreview.KindComment
	if got := DiscussLine(anchor, comment, ""); !strings.Contains(got, "(a comment)") || !strings.HasSuffix(got, "Reply with review_reply_comment.") {
		t.Errorf("no message: %q", got)
	}
	if long := DiscussLine(anchor, comment, strings.Repeat("é", 400)); len(long) > maxAskLine || !strings.Contains(long, "read it with review_selection") {
		t.Errorf("long: %q", long)
	}
}

// FR-REV-009 AC2 and AC3: Discuss types the comment's reference and review_selection gives the comment; the agent
// replies only on a discussed comment; a proposal is checked against the PR's lines and completed.
func TestDiscussReplyAndPropose(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	var typed []string
	env.TypePrompt = func(ctx context.Context, blockId string, line string) TypeOutcome {
		typed = append(typed, line)
		return TypeOutcome{Sent: true, Submitted: true}
	}
	m := MakeManager(env)
	ctx := context.Background()
	key := mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7}
	anchor := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 4, HeadOid: repo.head, Excerpt: "func main() {\n\tprintln(\"hi\")"}
	comment := mcpreview.CommentRef{Id: "c-1", Kind: mcpreview.KindComment, Subject: "line", Text: "Pourquoi println ?", Lang: "fr"}
	if _, err := m.Discuss(ctx, mcpreview.DiscussRequest{SessionKey: key, Anchor: anchor, Comment: comment}); err == nil {
		t.Fatal("discussed without a session")
	}
	if _, err := m.Start(ctx, "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	blockId := <-f.typedCh
	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	hello, err := m.Hello(ctx, "proc:5", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token})
	if err != nil {
		t.Fatal(err)
	}
	call := func(tool string, args string) mcpbrowser.CallResult {
		return m.Call(ctx, "proc:5", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: tool, Args: json.RawMessage(args)})
	}
	if r := call(mcpreview.ToolReplyComment, `{"commentid":"c-1","markdown":"oui"}`); !r.IsError || r.Content[0].Text != mcpreview.ErrNotDiscussed {
		t.Errorf("a reply on a comment not discussed: %+v", r)
	}
	if _, err := m.Discuss(ctx, mcpreview.DiscussRequest{SessionKey: key, Anchor: anchor, Comment: mcpreview.CommentRef{Id: "c-1"}}); err == nil {
		t.Error("an empty comment was discussed")
	}
	out, err := m.Discuss(ctx, mcpreview.DiscussRequest{SessionKey: key, Anchor: anchor, Comment: comment, Message: "C'est du debug ?"})
	if err != nil || !out.Sent {
		t.Fatalf("discuss %+v: %v", out, err)
	}
	if last := typed[len(typed)-1]; last != "Review comment c-1 (a comment) on main.go, head side, lines 3-4 (review_selection has it): C'est du debug ?" {
		t.Errorf("typed %q", last)
	}
	sel := call(mcpreview.ToolSelection, "{}")
	if !strings.Contains(sel.Content[0].Text, `"id": "c-1"`) || !strings.Contains(sel.Content[0].Text, "Pourquoi println ?") ||
		!strings.Contains(sel.Content[0].Text, "C'est du debug ?") || !strings.Contains(sel.Content[0].Text, "review_reply_comment") {
		t.Errorf("review_selection %s", sel.Content[0].Text)
	}
	if r := call(mcpreview.ToolReplyComment, `{"commentid":"c-1","markdown":"  "}`); !r.IsError {
		t.Error("an empty reply was taken")
	}
	if r := call(mcpreview.ToolReplyComment, `{"commentid":"c-1","markdown":"Oui, à retirer.","rewrite":"Retirer ce println de debug ?"}`); r.IsError {
		t.Fatalf("reply %+v", r)
	}

	if r := call(mcpreview.ToolProposeComment, `{"anchor":{"path":"main.go","side":"RIGHT","line":9},"text":"x"}`); !r.IsError {
		t.Error("a proposal past the file's end was taken")
	}
	if r := call(mcpreview.ToolProposeComment, `{"anchor":{"path":"nope.go","side":"RIGHT","line":1},"text":"x"}`); !r.IsError {
		t.Error("a proposal on a file outside the PR was taken")
	}
	if r := call(mcpreview.ToolProposeComment, `{"anchor":{"path":"main.go","side":"RIGHT","startline":3,"line":4,"excerpt":"made up"},"kind":"change","text":"Retirer le println."}`); r.IsError {
		t.Fatalf("proposal %+v", r)
	}
	var reply, proposal *mcpreview.Post
	for _, u := range f.published {
		if u.Post != nil && u.Post.Kind == mcpreview.PostReply {
			reply = u.Post
		}
		if u.Post != nil && u.Post.Kind == mcpreview.PostProposal {
			proposal = u.Post
		}
	}
	if reply == nil || reply.CommentId != "c-1" || reply.Text != "Retirer ce println de debug ?" || reply.Markdown != "Oui, à retirer." {
		t.Errorf("reply post %+v", reply)
	}
	if proposal == nil || proposal.Anchor.Excerpt != "func main() {\n\tprintln(\"hi\")" || proposal.Anchor.HeadOid != repo.head ||
		proposal.Subject != "line" || proposal.Lang != "fr" || proposal.CommentKind != mcpreview.KindChange || proposal.HeadOid != repo.head {
		t.Errorf("proposal post %+v %+v", proposal, proposal.Anchor)
	}
}
