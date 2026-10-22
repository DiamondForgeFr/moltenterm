// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/review"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestJoinIdentityFromAgentStates(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	job := localJob("job1", 1)
	w.pane(job, "b1", "tab1", waveobj.MetaMapType{molten.AgentFirstNameMetaKey: "Old"})
	w.s.Agents["b1"] = molten.AgentStateInfo{BlockId: "b1", Agent: "claude", AgentName: "Claude Code", State: "working",
		FirstName: "Valentin", Model: "claude-opus-5-5", ModelName: "Opus 5.5", Effort: "high"}

	s := find(t, Join(w.s), "job1")
	if s.FirstName != "Valentin" || s.Model != "claude-opus-5-5" || s.ModelName != "Opus 5.5" || s.Effort != "high" {
		t.Fatalf("identity: %+v", s)
	}
	if s.Origin != nil || s.Context != nil || s.ParentId != "" {
		t.Fatalf("a direct session without a branch: %+v", s)
	}
}

func TestJoinFirstNameFromMetaAndNoneForShells(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	agent := localJob("agent", 1)
	w.pane(agent, "b1", "tab1", waveobj.MetaMapType{molten.AgentFirstNameMetaKey: "Camille"})
	w.s.Agents["b1"] = molten.AgentStateInfo{BlockId: "b1", Agent: "codex", State: "idle"}
	shell := localJob("shell", 2)
	w.pane(shell, "b2", "tab1", waveobj.MetaMapType{molten.AgentFirstNameMetaKey: "Gone"})

	data := Join(w.s)
	if s := find(t, data, "agent"); s.FirstName != "Camille" {
		t.Fatalf("first name kept in the block: %+v", s)
	}
	if s := find(t, data, "shell"); s.FirstName != "" {
		t.Fatalf("a shell has no first name: %+v", s)
	}
}

func TestJoinOriginAndContext(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	ci := localJob("ci", 1)
	origin := review.AgentOrigin{Kind: review.AgentOriginInvestigate, Repo: "acme/app", Number: 891, Branch: "fix/890-dialog", Mode: "background", At: 77}
	w.pane(ci, "b1", "tab1", waveobj.MetaMapType{review.OriginMetaKey: map[string]any{
		"kind": origin.Kind, "repo": origin.Repo, "number": origin.Number, "branch": origin.Branch, "mode": origin.Mode, "at": origin.At,
	}, molten.WorktreeMetaKey: "/w/work-891"})
	w.s.Worktrees["/w/work-891"] = &molten.SessionWorktree{Path: "/w/work-891", Branch: "fix/890-dialog", Main: "/p/app"}
	panel := localJob("panel", 2)
	w.pane(panel, "b2", "tab1", waveobj.MetaMapType{mcpreview.SessionMetaKey: map[string]any{
		"id": "r1", "token": "secret", "repo": "acme/app", "number": 900, "headref": "feature/899-x", "startedat": 55,
	}})
	var asked []molten.SessionContextQuery
	w.s.Context = func(q molten.SessionContextQuery) *molten.SessionContext {
		asked = append(asked, q)
		if q.Number == 891 {
			return &molten.SessionContext{Repo: q.Repo, Branch: q.Branch, Ticket: 890, Pr: 891, PrState: molten.SessionPrMerged, PrUrl: "u"}
		}
		return nil
	}

	data := Join(w.s)
	s := find(t, data, "ci")
	if s.Origin == nil || s.Origin.Kind != review.AgentOriginInvestigate || s.Origin.Number != 891 || s.Origin.At != 77 {
		t.Fatalf("origin: %+v", s.Origin)
	}
	if s.Context == nil || s.Context.Ticket != 890 || s.Context.PrState != molten.SessionPrMerged {
		t.Fatalf("context: %+v", s.Context)
	}
	p := find(t, data, "panel")
	if p.Origin == nil || p.Origin.Kind != molten.SessionOriginReview || p.Origin.Number != 900 || p.Origin.At != 55 {
		t.Fatalf("review panel origin: %+v", p.Origin)
	}
	if p.Context == nil || p.Context.Pr != 900 || p.Context.Branch != "feature/899-x" {
		t.Fatalf("without the lookup's answer the origin's PR stays: %+v", p.Context)
	}
	want := molten.SessionContextQuery{Project: "/p/app", Branch: "fix/890-dialog", Repo: "acme/app", Number: 891}
	if len(asked) != 2 || asked[0] != want {
		t.Fatalf("queries: %+v", asked)
	}
}

func TestJoinNestsHandedSessions(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	w.pane(localJob("lead", 1), "b1", "tab1", nil)
	w.pane(localJob("helper", 2), "b2", "tab1", waveobj.MetaMapType{molten.HandedByMetaKey: "b1"})
	w.pane(localJob("self", 3), "b3", "tab1", waveobj.MetaMapType{molten.HandedByMetaKey: "b3"})
	w.pane(localJob("orphan", 4), "b4", "tab1", waveobj.MetaMapType{molten.HandedByMetaKey: "closed-block"})
	w.pane(localJob("x", 5), "b5", "tab1", waveobj.MetaMapType{molten.HandedByMetaKey: "b6"})
	w.pane(localJob("y", 6), "b6", "tab1", waveobj.MetaMapType{molten.HandedByMetaKey: "b5"})

	data := Join(w.s)
	if s := find(t, data, "helper"); s.ParentId != "lead" {
		t.Fatalf("helper under lead: %+v", s)
	}
	if s := find(t, data, "self"); s.ParentId != "" {
		t.Fatalf("never its own parent: %+v", s)
	}
	if s := find(t, data, "orphan"); s.ParentId != "" {
		t.Fatalf("a parent no longer listed: %+v", s)
	}
	x, y := find(t, data, "x"), find(t, data, "y")
	if x.ParentId != "" && y.ParentId != "" {
		t.Fatalf("a loop is cut: x=%q y=%q", x.ParentId, y.ParentId)
	}
}
