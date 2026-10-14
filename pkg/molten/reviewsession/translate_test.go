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

func TestTranslateLine(t *testing.T) {
	req := mcpreview.TranslateRequest{Lang: "en", Items: []mcpreview.TranslateItem{{Id: "a", Text: "x"}, {Id: "b", Text: "y"}}}
	got := TranslateLine(req)
	if !strings.HasPrefix(got, "MoltenTerm: translate 2 review comments into English (en)") || !strings.Contains(got, "review_set_translation") || len(got) > maxAskLine {
		t.Errorf("line %q", got)
	}
}

// FR-REV-010 AC1: Publish review's request becomes review_context's translate and one typed line; the agent's
// translation is taken only for an item of that request, in its language.
func TestTranslateRequestAndTool(t *testing.T) {
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
	req := mcpreview.TranslateRequest{SessionKey: key, Lang: "en-US", Items: []mcpreview.TranslateItem{
		{Id: "c-1", Kind: "change", Where: "main.go, head side, line 4 (line comment)", Text: "Renomme `x`.", Lang: "fr"},
		{Id: mcpreview.SummaryId, Text: "Merci", Lang: "fr"},
	}}
	if _, err := m.Translate(ctx, req); err == nil {
		t.Fatal("translated without a session")
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
	if r := call(mcpreview.ToolSetTranslation, `{"commentid":"c-1","text":"Rename x."}`); !r.IsError {
		t.Error("a translation was taken before MoltenTerm asked")
	}
	if _, err := m.Translate(ctx, mcpreview.TranslateRequest{SessionKey: key, Lang: "en"}); err == nil {
		t.Error("an empty request was typed")
	}
	result, err := m.Translate(ctx, req)
	if err != nil || !result.Sent || len(typed) != 1 || !strings.Contains(typed[0], "translate 2 review comments into English (en)") {
		t.Fatalf("translate %+v %v %v", result, err, typed)
	}
	r := call(mcpreview.ToolContext, "{}")
	var rc struct {
		PublicationLanguage string         `json:"publicationlanguage"`
		Translate           *translateInfo `json:"translate"`
	}
	if err := json.Unmarshal([]byte(r.Content[0].Text), &rc); err != nil {
		t.Fatal(err)
	}
	if rc.PublicationLanguage != "en" || rc.Translate == nil || len(rc.Translate.Items) != 2 || rc.Translate.Items[0].Where == "" || rc.Translate.Note == "" {
		t.Errorf("context %+v", rc)
	}
	if r := call(mcpreview.ToolSetTranslation, `{"commentid":"other","text":"x"}`); !r.IsError {
		t.Error("a translation of an item not asked was taken")
	}
	f.published = nil
	for _, id := range []string{"c-1", mcpreview.SummaryId} {
		if r := call(mcpreview.ToolSetTranslation, `{"commentid":"`+id+`","text":"Done."}`); r.IsError {
			t.Errorf("%s: %+v", id, r)
		}
	}
	var langs []string
	for _, u := range f.published {
		if u.Post != nil && u.Post.Kind == mcpreview.PostTranslation {
			langs = append(langs, u.Post.CommentId+":"+u.Post.Lang)
		}
	}
	if strings.Join(langs, ",") != "c-1:en,summary:en" {
		t.Errorf("translations posted %v", langs)
	}
}
