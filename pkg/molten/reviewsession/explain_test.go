// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// FR-REV-007 AC8: the depth the developer chose goes with the question, into the typed line and review_selection.
func TestAskDepth(t *testing.T) {
	anchor := &mcpreview.Anchor{Path: "pkg/a.go", Side: mcpreview.SideRight, Line: 3}
	got := AskLine(anchor, "why?", mcpreview.DepthDetailed)
	if got != "Review question (detailed answer) on pkg/a.go, head side, line 3 (review_selection has them): why?" {
		t.Errorf("detailed line %q", got)
	}
	if got := AskLine(nil, "why?", "other"); got != "Review question on the PR: why?" {
		t.Errorf("unknown depth %q", got)
	}

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
	if _, err := m.Start(ctx, "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	<-f.typedCh
	if _, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "q", Depth: "deep"}); err == nil {
		t.Error("a bad depth was taken")
	}
	sel := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 5, HeadOid: repo.head}
	if _, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: sel, Question: "pourquoi ?", Depth: mcpreview.DepthDetailed}); err != nil {
		t.Fatal(err)
	}
	if len(typed) != 1 || !strings.HasPrefix(typed[0], "Review question (detailed answer) on main.go") {
		t.Errorf("typed %q", typed)
	}
	s := m.find(key)
	raw, _ := json.Marshal(m.toolSelection(s))
	if !strings.Contains(string(raw), `\"depth\": \"detailed\"`) || !strings.Contains(string(raw), "explanation contract") {
		t.Errorf("review_selection %s", raw)
	}
	if m.askedDepth(s) != mcpreview.DepthDetailed {
		t.Errorf("asked depth %q", m.askedDepth(s))
	}
	if _, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "et ça ?"}); err != nil {
		t.Fatal(err)
	}
	if m.askedDepth(s) != mcpreview.DepthQuick {
		t.Errorf("default depth %q", m.askedDepth(s))
	}
	m.End(ctx, key)
}

// FR-REV-007 AC1, AC4, AC7, AC8: a card names its technique, takes the asked depth when it gives none, names one
// principle at most in quick depth, lists its sources, and cites other uses that exist in the worktree.
func TestExplanationContract(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	m := MakeManager(f.env(repo, t.TempDir()))
	ctx := context.Background()
	res, _ := m.Start(ctx, "tab1", startReq(repo))
	blockId := <-f.typedCh
	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	hello, err := m.Hello(ctx, "proc:9", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token})
	if err != nil {
		t.Fatal(err)
	}
	call := func(args string) mcpbrowser.CallResult {
		return m.Call(ctx, "proc:9", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: mcpreview.ToolPostExplanation, Args: json.RawMessage(args)})
	}
	key := mcpreview.SessionKey{Id: res.Session.Id}
	worktree := m.recOf(m.find(key)).Worktree
	if worktree == "" {
		t.Fatal("no worktree")
	}
	m.SetSelection(ctx, mcpreview.SelectionRequest{SessionKey: key, Anchor: &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, Line: 4},
		Question: "pourquoi ?", Depth: mcpreview.DepthDetailed})

	refused := map[string]string{
		`{"markdown":"x"}`:                  "sources",
		`{"markdown":"x","sources":["  "]}`: "sources",
		`{"markdown":"x","depth":"quick","principles":["KISS","DRY"],"sources":["main.go:4"]}`:  "one principle",
		`{"markdown":"x","sources":["main.go:4"],"related":["main.go"]}`:                        "path:line",
		`{"markdown":"x","sources":["main.go:4"],"related":["/etc/hosts:1"]}`:                   "path:line",
		`{"markdown":"x","sources":["main.go:4"],"related":["../x.go:1"]}`:                      "path:line",
		`{"markdown":"x","sources":["main.go:4"],"related":["main.go:9-3"]}`:                    "path:line",
		`{"markdown":"x","sources":["main.go:4"],"related":["main.go:99"]}`:                     "no such file or line",
		`{"markdown":"x","sources":["main.go:4"],"related":["nope.go:1"]}`:                      "no such file or line",
		`{"markdown":"x","sources":["main.go:4"],"related":["main.go:1"],"depth":"exhaustive"}`: "depth",
	}
	for args, want := range refused {
		r := call(args)
		if !r.IsError || !strings.Contains(r.Content[0].Text, want) {
			t.Errorf("%s: %+v, want %q", args, r, want)
		}
	}

	os.MkdirAll(filepath.Join(worktree, "pkg"), 0755)
	os.WriteFile(filepath.Join(worktree, "pkg", "lock.go"), []byte("package pkg\n\nfunc a() {}\nfunc b() {}"), 0644)
	ok := `{"anchor":{"path":"main.go","side":"RIGHT","line":4},"technique":" defer-unlock\n helper ","markdown":"x",` +
		`"principles":["KISS","SRP"," "],"sources":["main.go:4",".kilocode/rules/rules.md"],"related":["./pkg/lock.go:4","main.go:3-5"]}`
	if r := call(ok); r.IsError {
		t.Fatalf("contract answer %+v", r)
	}
	posts, _ := m.Posts(ctx, key)
	p := posts.Posts[len(posts.Posts)-1]
	if p.Technique != "defer-unlock helper" || p.Depth != mcpreview.DepthDetailed || len(p.Principles) != 2 ||
		strings.Join(p.Related, ",") != "pkg/lock.go:4,main.go:3-5" || len(p.Sources) != 2 {
		t.Errorf("post %+v", p)
	}
	m.SetSelection(ctx, mcpreview.SelectionRequest{SessionKey: key, Question: "et ?"})
	if r := call(`{"markdown":"x","principles":["KISS","DRY"],"sources":["main.go:4"]}`); !r.IsError {
		t.Error("a quick answer (the asked depth) took two principles")
	}
	m.End(ctx, mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7})
}

// DS-REV-006: the guide the session gets holds the whole explanation contract.
func TestGuideHasExplanationContract(t *testing.T) {
	guide, err := agentdocs.Files.ReadFile(agentdocs.ReviewGuideFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"## Explanations", "**Technique**", "no recorded reason", "**Alternatives**", "**Elsewhere in the code**",
		"Law of Demeter", "MOLTENTERM-PATCH", "what the code would look like if it were violated", "### Facts only",
		"about 8 lines at most", "at most one principle", "ends with its sources list", "`technique`",
	} {
		if !strings.Contains(string(guide), want) {
			t.Errorf("the review guide misses %q", want)
		}
	}
}

func TestCheckRelatedWithoutWorktree(t *testing.T) {
	got, err := checkRelated("", []string{"a/b.go:3", "c.ts:1-2", ""})
	if err != nil || strings.Join(got, ",") != "a/b.go:3,c.ts:1-2" {
		t.Errorf("got %v %v", got, err)
	}
	if _, err := checkRelated("", []string{"https://x.y/a.go:3"}); err == nil {
		t.Error("a web link was taken")
	}
}
