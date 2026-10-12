// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"strings"
	"testing"
)

// The board of #416: v1.0.0 released, milestone v1.0.1 finished and untagged, milestone v1.1.0 with open issues, and a
// feat commit since v1.0.0.
const board416 = `[
    {"number": 8, "title": "v1.1.0", "html_url": "https://m/8", "open_issues": 15},
    {"number": 7, "title": "v1.0.1", "html_url": "https://m/7", "open_issues": 0}
]`

func makeReleasedFixture(t *testing.T) *fixture {
	t.Helper()
	f := makeFixture(t)
	gitIn(t, f.checkout, "tag", "v1.0.0")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "v1.0.0")
	f.commitOnDevelop(t, "fix(#880): a crash")
	f.commitOnDevelop(t, "feat(#883): a feature")
	return f
}

func TestPlanProposesTheFinishedMilestone(t *testing.T) {
	f := makeReleasedFixture(t)
	f.gh.milestones = board416
	reports, err := f.env().Plan(context.Background(), []string{"rc", "public"}, "")
	mustRun(t, f, "plan", err)
	rc, public := reports[0], reports[1]
	if public.Tag != "v1.0.1" || public.How != HowMilestone || public.CommitsSuggest != "1.1.0" {
		t.Fatalf("public plan: %+v", public)
	}
	if !strings.Contains(public.Mismatch, "suggest 1.1.0 (a minor version); milestone v1.0.1 declares 1.0.1") {
		t.Fatalf("mismatch: %q", public.Mismatch)
	}
	if public.Milestone == nil || public.Milestone.Title != "v1.0.1" || len(public.Milestone.Issues) != 0 {
		t.Fatalf("public milestone: %+v", public.Milestone)
	}
	if rc.Tag != "v1.0.1-1" || rc.How != HowMilestone {
		t.Fatalf("rc plan: %+v", rc)
	}
	if public.Reason != "Milestone v1.0.1 is finished and not tagged yet." {
		t.Fatalf("reason: %q", public.Reason)
	}
}

func TestPlanWithoutAFinishedMilestoneKeepsTheCommits(t *testing.T) {
	f := makeReleasedFixture(t)
	f.gh.milestones = `[{"number": 8, "title": "v1.1.0", "html_url": "https://m/8", "open_issues": 15}]`
	reports, err := f.env().Plan(context.Background(), []string{"public"}, "")
	mustRun(t, f, "plan", err)
	if reports[0].Tag != "v1.1.0" || reports[0].How == HowMilestone || reports[0].Mismatch != "" {
		t.Fatalf("a milestone with open issues must not be proposed over the commits: %+v", reports[0])
	}

	f.gh.milestones = `[]`
	reports, err = f.env().Plan(context.Background(), []string{"public"}, "")
	mustRun(t, f, "plan", err)
	if reports[0].Tag != "v1.1.0" {
		t.Fatalf("without milestones, the commit-derived version: %+v", reports[0])
	}

	// An explicit version is never replaced, and a finished milestone already tagged is not proposed again.
	f.gh.milestones = board416
	reports, err = f.env().Plan(context.Background(), []string{"public"}, "2.0.0")
	mustRun(t, f, "plan --version", err)
	if reports[0].Tag != "v2.0.0" {
		t.Fatalf("explicit version: %+v", reports[0])
	}
	gitIn(t, f.checkout, "tag", "v1.0.1")
	reports, err = f.env().Plan(context.Background(), []string{"public"}, "")
	mustRun(t, f, "plan after v1.0.1", err)
	if reports[0].How == HowMilestone {
		t.Fatalf("a tagged milestone was proposed again: %+v", reports[0])
	}
}

func TestFinishedMilestonePicksTheNextDeclaredRelease(t *testing.T) {
	f := makeReleasedFixture(t)
	f.gh.milestones = `[
        {"number": 9, "title": "v1.2.0", "html_url": "https://m/9", "open_issues": 0},
        {"number": 7, "title": "Milestone v1.0.1", "html_url": "https://m/7", "open_issues": 0},
        {"number": 3, "title": "v0.9.0", "html_url": "https://m/3", "open_issues": 0},
        {"number": 4, "title": "Later", "html_url": "https://m/4", "open_issues": 0}
    ]`
	reports, err := f.env().Plan(context.Background(), []string{"public"}, "")
	mustRun(t, f, "plan", err)
	if reports[0].Tag != "v1.0.1" {
		t.Fatalf("want the lowest finished milestone above the last release: %+v", reports[0])
	}
}
