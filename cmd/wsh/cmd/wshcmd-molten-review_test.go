// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestFormatMoltenReviews(t *testing.T) {
	ready := moltenReviewPr{Number: 600, Title: "feat(#579): reviews", Branch: "feature/579-reviews-view", Ticket: 579, TicketTitle: "Reviews view", Merge: "behind"}
	ready.Ci.Success, ready.Ci.Failure = 3, 1
	ready.Report.State = "present"
	draft := moltenReviewPr{Number: 601, Title: "wip", Branch: "feature/580-x", Draft: true, Merge: "unknown"}
	out := formatMoltenReviews(moltenReviewsAnswer{State: "ok", Repo: "a/b", Target: "develop", Ready: []moltenReviewPr{ready}, Drafts: []moltenReviewPr{draft}})
	for _, want := range []string{"waiting for review into develop (a/b): 1", "#579", "Reviews view", "PR #600", "CI 1 failing, 3 passed", "test report", "behind: will be rebased", "in testing (drafts): 1", "test report unknown"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if got := formatMoltenReviews(moltenReviewsAnswer{State: "loggedout"}); !strings.Contains(got, "gh auth login") {
		t.Errorf("logged out: %q", got)
	}
}

func TestMoltenReviewsSettled(t *testing.T) {
	pr := []moltenReviewPr{{Number: 1}}
	cases := []struct {
		answer moltenReviewsAnswer
		want   bool
	}{
		{moltenReviewsAnswer{}, false},
		{moltenReviewsAnswer{State: "nogh"}, true},
		{moltenReviewsAnswer{State: "ok"}, true},
		{moltenReviewsAnswer{State: "ok", Ready: pr}, false},
		{moltenReviewsAnswer{State: "ok", Ready: pr, ReportsAt: 1}, true},
		{moltenReviewsAnswer{State: "ok", Drafts: pr, ReportsError: "x"}, true},
	}
	for i, c := range cases {
		if got := moltenReviewsSettled(c.answer); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
}
