// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func TestMoltenReviewNumber(t *testing.T) {
	for arg, want := range map[string]int{"12": 12, "#12": 12, " 7 ": 7} {
		if got, err := moltenReviewNumber(arg); err != nil || got != want {
			t.Errorf("%q: %d %v", arg, got, err)
		}
	}
	for _, arg := range []string{"", "0", "-3", "x"} {
		if _, err := moltenReviewNumber(arg); err == nil {
			t.Errorf("%q accepted", arg)
		}
	}
}

func TestMoltenReviewAgentMarker(t *testing.T) {
	env := map[string]string{"CLAUDECODE": "1"}
	if got := moltenReviewAgentMarker(func(name string) string { return env[name] }); got != "CLAUDECODE" {
		t.Errorf("Claude Code: %q", got)
	}
	env = map[string]string{"CODEX_SANDBOX": "seatbelt"}
	if got := moltenReviewAgentMarker(func(name string) string { return env[name] }); got != "CODEX_SANDBOX" {
		t.Errorf("Codex: %q", got)
	}
	if got := moltenReviewAgentMarker(func(string) string { return "" }); got != "" {
		t.Errorf("plain terminal: %q", got)
	}
}

func TestMoltenReviewRowOf(t *testing.T) {
	answer := moltenReviewsAnswer{Ready: []moltenReviewPr{{Number: 1}}, Drafts: []moltenReviewPr{{Number: 2}}}
	raw := map[string]any{
		"ready":  []any{map[string]any{"number": 1, "headoid": "a"}},
		"drafts": []any{map[string]any{"number": 2, "headoid": "b"}},
	}
	pr, row, ok := moltenReviewRowOf(answer, raw, 2)
	if !ok || pr.Number != 2 || row.(map[string]any)["headoid"] != "b" {
		t.Errorf("draft row: %+v %v %v", pr, row, ok)
	}
	if _, _, ok := moltenReviewRowOf(answer, raw, 3); ok {
		t.Error("PR 3 found")
	}
}

func testReviewComments() []moltenReviewComment {
	return []moltenReviewComment{
		{Id: "c1", Kind: "comment", State: "staged", Author: "developer", Anchor: mcpreview.Anchor{Path: "a.go", Side: "RIGHT", StartLine: 3, Line: 5},
			Original: moltenReviewText{Lang: "fr", Text: "Pourquoi ?"}, Translation: &moltenReviewText{Lang: "en", Text: "Why?"}},
		{Id: "c2", Kind: "change", State: "draft", Author: "developer", Anchor: mcpreview.Anchor{Path: "b.go", Side: "LEFT", Line: 9},
			Original: moltenReviewText{Text: "Rename it"}},
		{Id: "c3", Kind: "comment", State: "proposed", Author: "agent", Original: moltenReviewText{Text: "Maybe a test"}},
	}
}

func TestFormatMoltenReviewComments(t *testing.T) {
	out := formatMoltenReviewComments(testReviewComments())
	for _, want := range []string{"3 review comments", "staged  comment  a.go:3-5", "as written [fr]:\n    Pourquoi ?", "translation [en]:\n    Why?",
		"draft  change  b.go:9 (base)", "translation: none", "the whole PR (agent)"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if got := formatMoltenReviewComments(nil); got != "no review comments\n" {
		t.Errorf("empty: %q", got)
	}
}

func TestFormatMoltenReviewShowAndPublishPlan(t *testing.T) {
	pr := moltenReviewPr{Number: 12, Title: "feat(#5): x", Ticket: 5, TicketTitle: "Ticket five", Branch: "feature/5-x", Merge: "clean"}
	pr.Report.State = "present"
	st := moltenReviewState{Comments: testReviewComments(), Rounds: []moltenReviewRound{{HeadOid: "abcdef0123", PublishedAt: 1, GithubUrl: "https://x/r"}},
		Merge: &moltenReviewMerge{State: "merged", StartedAt: 1}, Cleanup: &moltenReviewCleanup{Steps: []moltenReviewCleanupStep{{Id: "ticket-done", State: "skipped", Reason: "no sf-workflow"}}}}
	t2 := moltenReviewTarget{Repo: "a/b", Target: "develop", Pr: pr, State: st}
	out := formatMoltenReviewShow(t2)
	for _, want := range []string{"PR #12  Ticket five", "ticket:   #5", "feature/5-x into develop (a/b)", "test report, clean", "briefing: none",
		"1 staged, 1 draft, 1 proposed", "proposals: 1", "round:    on abcdef0", "https://x/r", "merge:    merged", "skipped  Ticket moved to Done: no sf-workflow"} {
		if !strings.Contains(out, want) {
			t.Errorf("show: missing %q in:\n%s", want, out)
		}
	}
	plan := formatMoltenReviewPublishPlan(t2)
	if !strings.Contains(plan, "1 staged comments") || !strings.Contains(plan, "Why?") || strings.Contains(plan, "Rename it") {
		t.Errorf("publish plan:\n%s", plan)
	}
}

func TestFormatMoltenReviewPlanAndOutcome(t *testing.T) {
	plan := moltenReviewPlan{Title: "x", HeadRef: "feature/5-x", BaseRef: "develop", HeadOid: "abcdef0123", CanMerge: true, CreatedAt: 10,
		Checks:   []moltenReviewCheck{{Label: "CI passed", State: "ok"}, {Id: "comments", Label: "Comments published", State: "warn", Detail: "2 unpublished"}},
		Steps:    []moltenReviewCheck{{Label: "Rebase and merge into develop", Detail: "Bound to head abcdef0"}},
		Cleanup:  []moltenReviewCleanupStep{{Id: "pr", State: "planned"}},
		Warnings: []string{"comments"}}
	out := formatMoltenReviewPlan(12, plan)
	for _, want := range []string{"Validate PR #12", "feature/5-x into develop, head abcdef0", "ok   CI passed", "warn Comments published: 2 unpublished",
		"1. Rebase and merge into develop (Bound to head abcdef0)", "planned  PR merged", "warning: Comments published (the sheet asks you to confirm it before Merge)"} {
		if !strings.Contains(out, want) {
			t.Errorf("plan: missing %q in:\n%s", want, out)
		}
	}
	plan.CanMerge, plan.Reason = false, "CI is failing"
	if out := formatMoltenReviewPlan(12, plan); !strings.Contains(out, "cannot merge: CI is failing") {
		t.Errorf("blocked plan:\n%s", out)
	}
	state := moltenReviewState{Merge: &moltenReviewMerge{State: "merged", MergedOid: "1234567890", StartedAt: 20, EndedAt: 30},
		Cleanup: &moltenReviewCleanup{StartAt: 31, EndAt: 40, Steps: []moltenReviewCleanupStep{{Id: "remote-branch", State: "done"}}}}
	if out := formatMoltenReviewMerged(state, 20); !strings.Contains(out, "Merge: merged as 1234567") || !strings.Contains(out, "done     Remote branch deleted") {
		t.Errorf("outcome:\n%s", out)
	}
	if out := formatMoltenReviewMerged(state, 99); !strings.Contains(out, "could not be read") {
		t.Errorf("another merge:\n%s", out)
	}
}

func TestMoltenReviewRestartPlan(t *testing.T) {
	rounds := []moltenReviewRound{
		{Id: "r1", PublishedAt: 1000, RestartedAt: 2000},
		{Id: "r2", PublishedAt: 3000, GithubUrl: "https://github.com/acme/app/pull/7#pullrequestreview-9"},
		{Id: "r3"},
	}
	round, number := moltenReviewLastPublished(rounds)
	if round == nil || round.Id != "r2" || number != 2 {
		t.Fatalf("last published: %+v %d", round, number)
	}
	if r, _ := moltenReviewLastPublished([]moltenReviewRound{{Id: "r1"}}); r != nil {
		t.Errorf("no published round: %+v", r)
	}
	comments := []moltenReviewComment{{Round: "r2", State: "published"}, {Round: "r2", State: "published"},
		{Round: "r1", State: "published"}, {State: "staged"}}
	plan := formatMoltenReviewRestartPlan(7, *round, number, comments)
	for _, part := range []string{"Restart work on PR #7: review round 2", "pullrequestreview-9", "2 published comments go to an agent"} {
		if !strings.Contains(plan, part) {
			t.Errorf("plan misses %q:\n%s", part, plan)
		}
	}
	again := formatMoltenReviewRestartPlan(7, moltenReviewRound{Id: "r1", PublishedAt: 1000, RestartedAt: 2000, RestartWorktree: "/w/work-7"}, 1, nil)
	if !strings.Contains(again, "Already restarted") || !strings.Contains(again, "/w/work-7") {
		t.Errorf("a restarted round says so:\n%s", again)
	}
	done := formatMoltenReviewRestarted(moltenReviewRound{RestartAgent: "claude", RestartWorktree: "/w/work-7"}, 2)
	if done != "Review round 2 handed to claude in /w/work-7. Follow it in the Review tab.\n" {
		t.Errorf("restarted: %q", done)
	}
}
