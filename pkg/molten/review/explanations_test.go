// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// FR-REV-006 AC2, AC3 (DS-REV-007): the session's answers are kept with the PR and read again when it is reopened; a
// follow-up under an answer's id replaces it in place, keeping its lines, question and technique (FR-REV-007) when it
// names none.
func TestSessionExplanationsKept(t *testing.T) {
	dir := t.TempDir()
	svc := MakeService(dir, nil, func(k PrKey, state State) {})
	k := PrKey{Repo: "Owner/Repo", Number: 7}
	anchor := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 5, HeadOid: testHead}
	post := func(p mcpreview.Post) {
		p.Kind = mcpreview.PostExplanation
		p.HeadOid = testHead
		svc.SessionPosted(mcpreview.Update{Repo: k.Repo, Number: k.Number, Post: &p})
	}
	post(mcpreview.Post{Id: "eabcdef-1", Question: "pourquoi ?", Technique: "defer-unlock helper", Markdown: "Parce que.", Anchor: anchor, At: 10})
	post(mcpreview.Post{Id: "eabcdef-2", Question: "résume", Markdown: "La PR…", At: 11})
	post(mcpreview.Post{Id: "eabcdef-1", Markdown: "Parce que, en détail.", Depth: mcpreview.DepthDetailed, At: 12})
	state, err := MakeStore(dir).Get(k)
	if err != nil || len(state.Explanations) != 2 {
		t.Fatalf("explanations %+v: %v", state.Explanations, err)
	}
	first := state.Explanations[0]
	if first.Id != "eabcdef-1" || first.Markdown != "Parce que, en détail." || first.Question != "pourquoi ?" ||
		first.Technique != "defer-unlock helper" || first.Anchor == nil || first.Anchor.Line != 5 || first.At != 10 || first.UpdatedAt != 12 || first.Depth != mcpreview.DepthDetailed {
		t.Errorf("follow-up %+v", first)
	}
	if state.Explanations[1].Anchor != nil {
		t.Errorf("an answer on the PR got lines: %+v", state.Explanations[1])
	}
	if _, _, err := svc.store.SetExplanation(k, Explanation{Id: "x", Markdown: " "}); err == nil {
		t.Error("an empty answer was kept")
	}
	if _, _, err := svc.store.SetExplanation(k, Explanation{Id: "x", Markdown: "x", HeadOid: "--evil"}); err == nil {
		t.Error("a bad head was kept")
	}
}
