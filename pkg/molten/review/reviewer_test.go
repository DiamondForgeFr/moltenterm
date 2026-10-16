// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
)

func TestReviewerNameOf(t *testing.T) {
	if got := reviewerNameOf(" Anthony ", func() string { return "Someone Else" }); got != "Anthony" {
		t.Fatalf("setting first: %q", got)
	}
	if got := reviewerNameOf("", func() string { return "Anthony Gachet" }); got != "Anthony" {
		t.Fatalf("git user name's first word: %q", got)
	}
	if got := reviewerNameOf("", func() string { return "" }); got != "" {
		t.Fatalf("nothing known: %q", got)
	}
}

// mergeWithReviewer validates a clean PR and returns gh's writes.
func mergeWithReviewer(t *testing.T, pr fakePr, reviewer func(string) string, state func(m *Merger)) [][]string {
	t.Helper()
	gh := &fakeGh{views: []fakePr{pr}}
	m, dir, _ := testMerger(t, gh)
	m.reviewer = reviewer
	m.now = func() time.Time { return time.Date(2026, 10, 16, 18, 0, 0, 0, time.UTC) }
	if state != nil {
		state(m)
	}
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	got, _ := m.store.Get(testKey)
	if got.Merge == nil || got.Merge.State != MergeMerged {
		t.Fatalf("merged: %+v", got.Merge)
	}
	return gh.writes()
}

func TestValidateWritesReviewedByBeforeTheMerge(t *testing.T) {
	pr := cleanPr()
	pr.Body = agentsign.WithAgent("Resolves #590\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
		agentsign.Signature{FirstName: "Valentin", Agent: "Claude Code", Model: "Opus 5.5", Effort: "medium"})
	writes := mergeWithReviewer(t, pr, func(string) string { return "Anthony" }, func(m *Merger) {
		k := testKey
		if _, _, err := m.store.update(k, func(s *State) bool {
			s.Rounds = append(s.Rounds, Round{Id: "r1", GithubUrl: "https://github.com/owner/name/pull/7#pullrequestreview-1"})
			return true
		}); err != nil {
			t.Fatal(err)
		}
	})
	if len(writes) != 2 || writes[0][1] != "edit" || writes[1][1] != "merge" {
		t.Fatalf("edit then merge: %v", writes)
	}
	body := writes[0][4]
	if writes[0][3] != "--body" {
		t.Fatalf("edit args: %v", writes[0])
	}
	b, ok := agentsign.ParseBlock(body)
	if !ok || b.Reviewed == nil || *b.Reviewed != (agentsign.Review{Name: "Anthony", Date: "2026-10-16", Url: "https://github.com/owner/name/pull/7#pullrequestreview-1"}) {
		t.Fatalf("review line: %+v\n%s", b, body)
	}
	if len(b.Agents) != 1 || b.Agents[0].FirstName != "Valentin" || !strings.HasSuffix(body, "Generated with [Claude Code](https://claude.com/claude-code)\n") {
		t.Fatalf("agent kept, generated line last:\n%s", body)
	}
}

func TestValidateReviewerFallsBackToTheAuthor(t *testing.T) {
	writes := mergeWithReviewer(t, cleanPr(), func(string) string { return "" }, nil)
	if len(writes) != 2 || !strings.Contains(writes[0][4], "Reviewed by devlogin · 2026-10-16") {
		t.Fatalf("author's login: %v", writes)
	}
}

func TestValidateWithoutReviewerWritesNoLine(t *testing.T) {
	writes := mergeWithReviewer(t, cleanPr(), nil, nil)
	if len(writes) != 1 || writes[0][1] != "merge" {
		t.Fatalf("only the merge: %v", writes)
	}
}
