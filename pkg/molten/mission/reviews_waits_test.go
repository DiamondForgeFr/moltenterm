// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDeclaredWaits(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		text string
		want []int
	}{
		{"Resolves #1832\n\nDepends on #1837 (merge it first).", []int{1837}},
		{"Waiting on #12 and #13", []int{12, 13}},
		{"- **Blocked by:** #7", []int{7}},
		{"## Blocked by\n\n- #21 the parser\n- [ ] #22\n\nNotes #99", []int{21, 22}},
		{"Held until #5 merges", []int{5}},
		{"En attente de #44", []int{44}},
		{"Dépend de #45", []int{45}},
		// A sentence that only mentions a dependency, a closing keyword, or a link fragment names nothing.
		{"No longer depends on #8", nil},
		{"Fixes #9, see https://x/y#10", nil},
		{"This PR waits for nothing.", nil},
	} {
		if got := DeclaredWaits(c.text); !reflect.DeepEqual(got, c.want) {
			t.Errorf("DeclaredWaits(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

// #1841: a draft held until another PR merges says so in its body, in a comment of its author (the lead), in its
// ticket's body or through GitHub's "blocked by" relationship; only what is still open is kept.
func TestReadReviewFactsWaits(t *testing.T) {
	t.Parallel()
	var queries []string
	run := func(ctx context.Context, dir string, name string, a ...string) ([]byte, error) {
		query := ""
		for _, arg := range a {
			if q, ok := strings.CutPrefix(arg, "query="); ok {
				query = q
			}
		}
		queries = append(queries, query)
		if strings.Contains(query, "n17:") {
			return []byte(`{"data":{"repository":{
				"n17":{"__typename":"PullRequest","number":17,"title":"Remote hosts","url":"https://x/pull/17","state":"OPEN"},
				"n18":{"__typename":"PullRequest","number":18,"title":"Merged already","url":"https://x/pull/18","state":"MERGED"},
				"n19":{"__typename":"Issue","number":19,"title":"Parser","url":"https://x/issues/19","state":"OPEN"}
			}}}`), nil
		}
		if strings.Contains(query, "blockedBy") {
			// An older GitHub Enterprise without issue relationships refuses the whole query.
			if strings.Contains(query, "p30:") {
				return []byte(`{"errors":[{"message":"Field 'blockedBy' doesn't exist on type 'Issue'"}]}`), errors.New("exit status 1")
			}
			return []byte(`{"data":{"repository":{
				"p20":{"title":"held","comments":{"nodes":[
					{"body":"Depends on #18","url":"https://x/c1","author":{"login":"Lead"}},
					{"body":"Depends on #14","url":"https://x/c2","author":{"login":"someone"}}]}},
				"t21":{"title":"Ticket","url":"https://x/issues/21","body":"**Blocked by:** #17","comments":{"nodes":[]},
					"blockedBy":{"nodes":[
						{"__typename":"Issue","number":16,"title":"Schema","url":"https://x/issues/16","state":"OPEN"},
						{"__typename":"Issue","number":15,"title":"Done","url":"https://x/issues/15","state":"CLOSED"}]}}
			}}}`), nil
		}
		return []byte(`{"data":{"repository":{"p30":{"title":"plain","comments":{"nodes":[]}},"t31":{"title":"T","comments":{"nodes":[]}}}}}`), nil
	}
	pr := makeReviewPr(ghReviewPr{Number: 20, HeadRefName: "fix/21-held", Body: "Resolves #21\n\nWaiting on #19"}, nil)
	pr.Ticket, pr.Author = 21, "lead"
	facts, err := readAllReviewFacts(context.Background(), run, "/p", "acme/app", []ReviewPr{pr})
	if err != nil || facts.waitsErr != nil {
		t.Fatalf("read: %v %v", err, facts.waitsErr)
	}
	got := facts.waits[20]
	want := []ReviewDependency{
		{Number: 19, Title: "Parser", Url: "https://x/issues/19", Kind: ReviewWaitKindIssue, State: ReviewWaitOpen, From: ReviewWaitFromBody},
		{Number: 17, Title: "Remote hosts", Url: "https://x/pull/17", Kind: ReviewWaitKindPr, State: ReviewWaitOpen, From: ReviewWaitFromTicket},
		{Number: 16, Title: "Schema", Url: "https://x/issues/16", Kind: ReviewWaitKindIssue, State: ReviewWaitOpen, From: ReviewWaitFromRelation},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("waits:\n got %+v\nwant %+v", got, want)
	}
	if !strings.Contains(queries[1], "n18:") || strings.Contains(queries[1], "n14:") {
		t.Fatalf("only the author's comments are read: %s", queries[1])
	}

	queries = nil
	plain := ReviewPr{Number: 30, Ticket: 31}
	facts, err = readAllReviewFacts(context.Background(), run, "/p", "acme/app", []ReviewPr{plain})
	if err != nil || len(queries) != 2 || strings.Contains(queries[1], "blockedBy") {
		t.Fatalf("without relationships the query is asked again without them: %v %v", err, queries)
	}
	if facts.reports[30].State != ReviewReportMissing || len(facts.waits) != 0 {
		t.Fatalf("the reports still come, nothing waits: %+v %+v", facts.reports, facts.waits)
	}
}

// The waits a query read are on the PRs of the next answers.
func TestReviewsApplyWaits(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	reviews := MakeReviews(nil, nil, nil)
	reviews.reports[dir] = &reviewReportsState{}
	reviews.storeWaits(dir, map[int][]ReviewDependency{20: {{Number: 17, State: ReviewWaitOpen, From: ReviewWaitFromBody}}})
	answer := ReviewsAnswer{Dir: dir, Drafts: []ReviewPr{{Number: 20}, {Number: 22}}}
	reviews.applyKnownReports(&answer)
	if len(answer.Drafts[0].WaitsOn) != 1 || answer.Drafts[0].WaitsOn[0].Number != 17 || answer.Drafts[1].WaitsOn != nil {
		t.Fatalf("waits applied: %+v", answer.Drafts)
	}
}
