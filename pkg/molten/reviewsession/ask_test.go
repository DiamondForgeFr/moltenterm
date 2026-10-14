// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func TestAskLine(t *testing.T) {
	anchor := &mcpreview.Anchor{Path: "pkg/a.go", Side: mcpreview.SideLeft, StartLine: 10, Line: 14}
	got := AskLine(anchor, "Pourquoi\n  ce verrou ?", "")
	want := "Review question on pkg/a.go, base side, lines 10-14 (review_selection has them): Pourquoi ce verrou ?"
	if got != want {
		t.Errorf("got %q", got)
	}
	one := &mcpreview.Anchor{Path: "a.ts", Side: mcpreview.SideRight, Line: 3}
	if got := AskLine(one, "why?", mcpreview.DepthQuick); !strings.Contains(got, "head side, line 3 ") {
		t.Errorf("one line: %q", got)
	}
	if got := AskLine(nil, "what does this PR do?", ""); got != "Review question on the PR: what does this PR do?" {
		t.Errorf("no anchor: %q", got)
	}
	long := AskLine(anchor, strings.Repeat("é", 400), mcpreview.DepthDetailed)
	if len(long) > maxAskLine || !strings.HasSuffix(long, "read it with review_selection and answer it.") {
		t.Errorf("long: %d %q", len(long), long)
	}
}

// FR-REV-003 AC2: the question reaches the session's terminal with the selection's reference, and review_selection
// gives the lines and the whole question.
func TestAsk(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	var typed []string
	outcome := TypeOutcome{Sent: true, Submitted: true, Message: "Sent to Claude Code."}
	env.TypePrompt = func(ctx context.Context, blockId string, line string) TypeOutcome {
		typed = append(typed, blockId+"|"+line)
		return outcome
	}
	m := MakeManager(env)
	ctx := context.Background()
	key := mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7}
	if res, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "why?"}); err != nil || res.Sent || res.Reason != mcpreview.ReasonSessionEnded {
		t.Fatal("asked without a session")
	}
	if _, err := m.Start(ctx, "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	blockId := <-f.typedCh
	anchor := &mcpreview.Anchor{Path: "a.txt", Side: mcpreview.SideRight, StartLine: 1, Line: 2, HeadOid: repo.head, Excerpt: "x\ny"}
	if _, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: anchor, Question: "  "}); err == nil {
		t.Error("an empty question was sent")
	}
	if _, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: &mcpreview.Anchor{Path: "a.txt", Side: "UP", Line: 1}, Question: "q"}); err == nil {
		t.Error("a bad anchor was taken")
	}
	out, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: anchor, Text: "x\ny", Question: "Que fait ce code ?"})
	if err != nil || !out.Sent || !out.Submitted {
		t.Fatalf("ask %+v: %v", out, err)
	}
	want := blockId + "|Review question on a.txt, head side, lines 1-2 (review_selection has them): Que fait ce code ?"
	if len(typed) != 1 || typed[0] != want {
		t.Errorf("typed %q", typed)
	}
	s := m.find(key)
	sel := m.toolSelection(s)
	raw, _ := json.Marshal(sel)
	if !strings.Contains(string(raw), "Que fait ce code ?") || !strings.Contains(string(raw), `\"line\": 2`) {
		t.Errorf("review_selection %s", raw)
	}
	outcome = TypeOutcome{Retry: true, Reason: "working", Message: "Claude Code is working: wait for its turn to end."}
	out, err = m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "et ensuite ?"})
	if err != nil || out.Sent || !out.Busy || !out.Queued || out.Position != 1 || !strings.Contains(out.Message, "working") || out.Reason != "working" {
		t.Errorf("busy %+v: %v", out, err)
	}
	m.End(ctx, key)
}
