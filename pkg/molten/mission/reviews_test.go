// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const reviewsSfManifest = `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}","fix":"fix/{N}-{description}","release":"rc-{version}"}}}`

const reviewsPrs = `[
 {"number":10,"title":"old ready","headRefName":"feature/7-old","baseRefName":"develop","isDraft":false,"updatedAt":"2026-10-10T10:00:00Z","mergeStateStatus":"BEHIND","author":{"login":"ag"},
  "statusCheckRollup":[{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"StatusContext","context":"local-ci","state":"SUCCESS"}]},
 {"number":11,"title":"new ready","headRefName":"fix/8-crash","baseRefName":"develop","isDraft":false,"updatedAt":"2026-10-12T10:00:00Z","mergeStateStatus":"CLEAN",
  "statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"FAILURE"},{"name":"lint","status":"IN_PROGRESS"}],"closingIssuesReferences":[{"number":99}]},
 {"number":12,"title":"draft","headRefName":"feature/9-wip","baseRefName":"develop","isDraft":true,"updatedAt":"2026-10-13T10:00:00Z","mergeStateStatus":"DRAFT"},
 {"number":13,"title":"release","headRefName":"rc-1.0.0","baseRefName":"main","isDraft":false,"updatedAt":"2026-10-13T11:00:00Z"},
 {"number":14,"title":"fork","headRefName":"feature/3-x","baseRefName":"develop","isDraft":false,"isCrossRepository":true,"updatedAt":"2026-10-13T12:00:00Z"},
 {"number":15,"title":"no ticket","headRefName":"my-branch","baseRefName":"develop","isDraft":false,"updatedAt":"2026-10-01T12:00:00Z","mergeStateStatus":"DIRTY"}
]`

func reviewsProject(t *testing.T, manifest string) string {
	dir := t.TempDir()
	if manifest != "" {
		os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(manifest), 0644)
	}
	return dir
}

func reviewsSnapshot(dir string, prs string) Snapshot {
	return Snapshot{
		Dir:      dir,
		Git:      &GitSnapshot{Trunk: "trunk-from-git"},
		Github:   &GithubSnapshot{State: GithubStateOk, Repo: "acme/app", Url: "https://github.com/acme/app", Prs: json.RawMessage(prs)},
		GithubAt: 1,
	}
}

func numbers(prs []ReviewPr) []int {
	rtn := []int{}
	for _, pr := range prs {
		rtn = append(rtn, pr.Number)
	}
	return rtn
}

func TestBuildReviewsListsReadyPrsOfTheTarget(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	answer := BuildReviews(reviewsSnapshot(dir, reviewsPrs))
	if answer.Target != "develop" || answer.TargetFrom != ReviewTargetFromSaaSFoundry {
		t.Fatalf("target: %q from %q", answer.Target, answer.TargetFrom)
	}
	if got := numbers(answer.Ready); !reflect.DeepEqual(got, []int{11, 10, 15}) {
		t.Fatalf("ready, newest update first, no other base, no fork: %v", got)
	}
	if got := numbers(answer.Drafts); !reflect.DeepEqual(got, []int{12}) {
		t.Fatalf("drafts apart: %v", got)
	}
	byNumber := map[int]ReviewPr{}
	for _, pr := range answer.Ready {
		byNumber[pr.Number] = pr
	}
	if pr := byNumber[10]; pr.Ticket != 7 || pr.TicketFrom != ReviewTicketFromBranch || pr.Merge != ReviewMergeBehind || pr.Author != "ag" {
		t.Fatalf("ticket from the branch pattern, behind: %+v", pr)
	}
	if pr := byNumber[10]; pr.Ci.State != ReviewCheckSuccess || pr.Ci.Success != 2 || !pr.Ci.Checks[1].Local {
		t.Fatalf("GitHub checks and local-* statuses: %+v", pr.Ci)
	}
	if pr := byNumber[11]; pr.Ticket != 99 || pr.TicketFrom != ReviewTicketFromClosing || pr.Merge != ReviewMergeClean {
		t.Fatalf("ticket from closingIssuesReferences first: %+v", pr)
	}
	if pr := byNumber[11]; pr.Ci.State != ReviewCheckFailure || pr.Ci.Failure != 1 || pr.Ci.Pending != 1 {
		t.Fatalf("a failing check wins: %+v", pr.Ci)
	}
	if pr := byNumber[15]; pr.Ticket != 0 || pr.Merge != ReviewMergeConflicts || pr.Report.State != ReviewReportUnknown {
		t.Fatalf("no ticket, conflicts, report not read yet: %+v", pr)
	}
}

// #683: the row's merge state reads mergeable first, as the Validate plan does (pkg/molten/review/merge.go).
func TestReviewMergeOfPr(t *testing.T) {
	cases := []struct {
		mergeable, state, want string
	}{
		{"MERGEABLE", "CLEAN", ReviewMergeClean},
		{"MERGEABLE", "HAS_HOOKS", ReviewMergeClean},
		{"MERGEABLE", "BEHIND", ReviewMergeBehind},
		{"CONFLICTING", "DIRTY", ReviewMergeConflicts},
		{"CONFLICTING", "BLOCKED", ReviewMergeConflicts},
		{"", "DIRTY", ReviewMergeConflicts},
		{"UNKNOWN", "CLEAN", ReviewMergeUnknown},
		{"MERGEABLE", "UNKNOWN", ReviewMergeUnknown},
		{"", "", ReviewMergeUnknown},
		{"MERGEABLE", "BLOCKED", ReviewMergeBlocked},
		{"MERGEABLE", "UNSTABLE", ReviewMergeFailing},
		{"MERGEABLE", "DRAFT", ReviewMergeClean},
		{"CONFLICTING", "DRAFT", ReviewMergeConflicts},
		{"", "DRAFT", ReviewMergeUnknown},
	}
	for _, c := range cases {
		if got := ReviewMergeOfPr(c.mergeable, c.state); got != c.want {
			t.Errorf("ReviewMergeOfPr(%q, %q) = %q, want %q", c.mergeable, c.state, got, c.want)
		}
	}
	answer := BuildReviews(reviewsSnapshot(reviewsProject(t, reviewsSfManifest),
		`[{"number":1,"headRefName":"feature/4-a","baseRefName":"develop","mergeable":"CONFLICTING","mergeStateStatus":"BLOCKED"}]`))
	if pr := answer.Ready[0]; pr.Merge != ReviewMergeConflicts || pr.Mergeable != "CONFLICTING" || pr.MergeState != "BLOCKED" {
		t.Fatalf("a conflicting PR shows its conflict even when GitHub says blocked: %+v", pr)
	}
}

func TestBuildReviewsFallsBackToTheTrunk(t *testing.T) {
	dir := reviewsProject(t, "")
	answer := BuildReviews(reviewsSnapshot(dir, `[{"number":1,"headRefName":"feature/4-a","baseRefName":"trunk-from-git"}]`))
	if answer.Target != "trunk-from-git" || answer.TargetFrom != ReviewTargetFromTrunk || len(answer.Ready) != 1 {
		t.Fatalf("trunk fallback: %+v", answer)
	}
	if answer.Ready[0].Ticket != 4 {
		t.Fatalf("default branch pattern: %+v", answer.Ready[0])
	}
}

func TestBuildReviewsKeepsGithubStates(t *testing.T) {
	dir := reviewsProject(t, "")
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateLoggedOut, Message: "run gh auth login"}}
	answer := BuildReviews(snap)
	if answer.State != GithubStateLoggedOut || answer.Message == "" || len(answer.Ready) != 0 {
		t.Fatalf("logged out: %+v", answer)
	}
	if never := BuildReviews(Snapshot{Dir: dir}); never.State != "" || never.Ready == nil {
		t.Fatalf("not read yet: %+v", never)
	}
}

func TestIsTestReport(t *testing.T) {
	cases := map[string]bool{
		"## Test report (#576)\n\nall green":                                 true,
		"<!-- marker -->\n### Test Report\n":                                 true,
		"## Plan (medium)\n\n## Test report":                                 false,
		"<!-- moltenterm-perf-report -->\n# MoltenTerm performance report\n": false,
		"Test report: see below":                                             false,
	}
	for body, want := range cases {
		if got := IsTestReport(body); got != want {
			t.Errorf("IsTestReport(%q) = %v, want %v", body, got, want)
		}
	}
}

func TestReadReviewReports(t *testing.T) {
	var args []string
	run := func(ctx context.Context, dir string, name string, a ...string) ([]byte, error) {
		args = a
		return []byte(`{"data":{"repository":{
			"p10":{"title":"old ready","comments":{"nodes":[{"body":"## Test report (#7)","url":"https://x/c1"},{"body":"thanks","url":"https://x/c2"}]}},
			"t7":{"title":"Ticket seven","url":"https://x/i7","comments":{"nodes":[]}},
			"p11":{"title":"new ready","comments":{"nodes":[]}},
			"t99":{"title":"Ticket 99","url":"https://x/i99","comments":{"nodes":[{"body":"## Test report","url":"https://x/c3"}]}},
			"p15":{"title":"no ticket","comments":{"nodes":[{"body":"## Plan","url":"https://x/c4"}]}}
		}},"errors":[{"message":"t8 is not an issue"}]}`), errors.New("gh api graphql: partial")
	}
	prs := []ReviewPr{{Number: 10, Ticket: 7}, {Number: 11, Ticket: 99}, {Number: 15}, {Number: 16, Ticket: 8}}
	reports, tickets, err := ReadReviewReports(context.Background(), run, "/p", "acme/app", prs)
	if err != nil {
		t.Fatalf("partial GraphQL errors keep the data: %v", err)
	}
	if strings.Join(args[:2], " ") != "api graphql" || !contains(args, "owner=acme") || !contains(args, "name=app") {
		t.Fatalf("the repository is named: %v", args)
	}
	if r := reports[10]; r.State != ReviewReportPresent || r.Where != "pr" || r.Url != "https://x/c1" {
		t.Fatalf("report on the PR: %+v", r)
	}
	if r := reports[11]; r.State != ReviewReportPresent || r.Where != "ticket" {
		t.Fatalf("report on the ticket: %+v", r)
	}
	if reports[15].State != ReviewReportMissing || reports[16].State != ReviewReportUnknown {
		t.Fatalf("missing and unknown: %+v", reports)
	}
	if tickets[7].Title != "Ticket seven" || tickets[99].Url != "https://x/i99" {
		t.Fatalf("ticket titles: %+v", tickets)
	}
	enterprise := []string{}
	ReadReviewReports(context.Background(), func(ctx context.Context, dir string, name string, a ...string) ([]byte, error) {
		enterprise = a
		return nil, errors.New("x")
	}, "/p", "ghe.example.com/acme/app", prs[:1])
	if !contains(enterprise, "--hostname") || !contains(enterprise, "ghe.example.com") {
		t.Fatalf("enterprise host: %v", enterprise)
	}
}

func contains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}

func TestGhRepoArgs(t *testing.T) {
	if got := ghRepoArgs("acme/app", []string{"pr", "list"}); !reflect.DeepEqual(got, []string{"pr", "list", "--repo", "acme/app"}) {
		t.Fatalf("pr list: %v", got)
	}
	if got := ghRepoArgs("acme/app", []string{"api", "repos/{owner}/{repo}/milestones"}); !reflect.DeepEqual(got, []string{"api", "repos/acme/app/milestones"}) {
		t.Fatalf("api: %v", got)
	}
	if got := ghRepoArgs(ghRepoRef("acme/app", "https://ghe.example.com/acme/app"), []string{"api", "repos/{owner}/{repo}"}); !reflect.DeepEqual(got, []string{"api", "repos/acme/app", "--hostname", "ghe.example.com"}) {
		t.Fatalf("enterprise api: %v", got)
	}
	if got := ghRepoArgs("", []string{"pr", "list"}); !reflect.DeepEqual(got, []string{"pr", "list"}) {
		t.Fatalf("no repository: %v", got)
	}
}

func TestCollectGithubNamesTheRepository(t *testing.T) {
	var calls [][]string
	run := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		if args[0] == "repo" {
			return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
		}
		return []byte(`[]`), nil
	}
	CollectGithub(context.Background(), run, t.TempDir())
	for _, args := range calls[1:] {
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--repo acme/app") && !strings.Contains(joined, "repos/acme/app/") {
			t.Fatalf("a gh call without the repository: %v", args)
		}
	}
}

// The reports are read once per minute while the PRs stay the same, again when a PR changes, never twice at once.
func TestReviewsReportsThrottle(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	now := time.Unix(1_000_000, 0)
	reviews := MakeReviews(nil, nil, nil)
	reviews.now = func() time.Time { return now }
	answer := func(prs string) *ReviewsAnswer {
		a := BuildReviews(reviewsSnapshot(dir, prs))
		return &a
	}
	if !reviews.prepareReports(answer(reviewsPrs), false) {
		t.Fatal("first ask reads the reports")
	}
	if reviews.prepareReports(answer(reviewsPrs), true) {
		t.Fatal("never two queries at once")
	}
	reviews.storeReports(dir, map[int]ReviewReport{10: {State: ReviewReportPresent}}, map[int]reviewTicket{7: {Title: "seven"}}, "")
	now = now.Add(20 * time.Second)
	got := answer(reviewsPrs)
	if reviews.prepareReports(got, false) {
		t.Fatal("same PRs within the minute: cached")
	}
	if got.Ready[1].Report.State != ReviewReportPresent || got.Ready[1].TicketTitle != "seven" || got.ReportsAt == 0 {
		t.Fatalf("cached reports fill the answer: %+v", got.Ready[1])
	}
	if !reviews.prepareReports(answer(strings.Replace(reviewsPrs, "2026-10-10T10:00:00Z", "2026-10-14T10:00:00Z", 1)), false) {
		t.Fatal("an updated PR reads them again")
	}
	reviews.storeReports(dir, nil, nil, "")
	now = now.Add(5 * time.Second)
	if reviews.prepareReports(answer(reviewsPrs), true) {
		t.Fatal("at most one query every 10 s")
	}
	now = now.Add(time.Minute)
	if !reviews.prepareReports(answer(reviewsPrs), false) {
		t.Fatal("after a minute, read again")
	}
	empty := BuildReviews(Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateNoGh}})
	if reviews.prepareReports(&empty, true) {
		t.Fatal("no query without GitHub")
	}
}

// The view asks; the collector is read within its limits and the reports come as an event.
func TestReviewsGetPublishesReports(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	var graphql atomic.Int32
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name != "gh" {
			return nil, errors.New("no git here")
		}
		switch {
		case args[0] == "repo":
			return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
		case args[0] == "pr":
			return []byte(reviewsPrs), nil
		case args[0] == "api" && args[1] == "graphql":
			graphql.Add(1)
			return []byte(`{"data":{"repository":{"p10":{"comments":{"nodes":[]}},"p11":{"comments":{"nodes":[{"body":"## Test report","url":"u"}]}}}}}`), nil
		}
		return []byte(`[]`), nil
	}
	published := make(chan ReviewsAnswer, 4)
	collector := MakeCollector("", run, nil)
	reviews := MakeReviews(collector, run, func(a ReviewsAnswer) { published <- a })
	first, err := reviews.Get(ReviewsRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if first.State != "" {
		t.Fatalf("before the collector read GitHub: %+v", first)
	}
	deadline := time.Now().Add(5 * time.Second)
	var answer ReviewsAnswer
	for time.Now().Before(deadline) {
		answer, _ = reviews.Get(ReviewsRequest{Dir: dir})
		if answer.State == GithubStateOk {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(answer.Ready) != 3 {
		t.Fatalf("ready PRs from the collector: %+v", answer)
	}
	select {
	case got := <-published:
		if got.Ready[0].Number != 11 || got.Ready[0].Report.State != ReviewReportPresent || got.Ready[1].Report.State != ReviewReportMissing {
			t.Fatalf("published reports: %+v", got.Ready)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reports were not published")
	}
	if graphql.Load() != 1 {
		t.Fatalf("one query: %d", graphql.Load())
	}
}

// #688: the rail's passive ask reads GitHub only for a project whose origin is on GitHub, and never starts the
// reports query.
func TestReviewsPassiveGet(t *testing.T) {
	for _, withOrigin := range []bool{false, true} {
		dir := makeGitFlowRepo(t)
		os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(reviewsSfManifest), 0644)
		if withOrigin {
			gitRun(t, dir, "remote", "add", "origin", "https://github.com/acme/app.git")
		}
		var ghCalls, graphql atomic.Int32
		run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
			if name != "gh" {
				return plainRunner(ctx, d, name, args...)
			}
			ghCalls.Add(1)
			switch {
			case args[0] == "repo":
				return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
			case args[0] == "pr":
				return []byte(reviewsPrs), nil
			case args[0] == "api" && args[1] == "graphql":
				graphql.Add(1)
			}
			return []byte(`[]`), nil
		}
		collector := MakeCollector("", run, nil)
		reviews := MakeReviews(collector, run, nil)
		// Generous: it only bounds a failing run.
		deadline := time.Now().Add(time.Minute)
		var answer ReviewsAnswer
		for time.Now().Before(deadline) {
			var err error
			answer, err = reviews.Get(ReviewsRequest{Dir: dir, Passive: true})
			if err != nil {
				t.Fatal(err)
			}
			snap, _ := collector.Cached(filepath.Clean(dir))
			settled := snap.Git != nil && !snap.Refreshing
			if settled && (!withOrigin || answer.State == GithubStateOk) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if !withOrigin {
			// Once git is known, the next ask is the one that would read GitHub.
			reviews.Get(ReviewsRequest{Dir: dir, Passive: true})
			if snap, _ := collector.Cached(filepath.Clean(dir)); snap.Refreshing {
				t.Fatal("no GitHub origin: a refresh started")
			}
			if ghCalls.Load() != 0 || answer.State != "" {
				t.Fatalf("no GitHub origin: %d gh calls, state %q", ghCalls.Load(), answer.State)
			}
			continue
		}
		if answer.State != GithubStateOk || len(answer.Ready) != 3 {
			t.Fatalf("GitHub origin: %+v", answer)
		}
		if graphql.Load() != 0 {
			t.Fatal("a passive ask never starts the reports query")
		}
	}
}
