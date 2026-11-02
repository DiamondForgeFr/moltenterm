// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A GitHub of merged PRs for the history: pages of 100 by cursor, the newest update first, and tickets by number.
type historyGh struct {
	lock   sync.Mutex
	prs    []map[string]any
	pages  atomic.Int32
	tix    atomic.Int32
	noType bool
}

var historyAliasRe = regexp.MustCompile(`t(\d+):issueOrPullRequest`)

func (g *historyGh) add(number int, base string, mergedAt time.Time, extra map[string]any) {
	g.lock.Lock()
	defer g.lock.Unlock()
	pr := map[string]any{
		"number": number, "title": fmt.Sprintf("pr %d", number), "url": fmt.Sprintf("https://github.com/acme/app/pull/%d", number),
		"headRefName": fmt.Sprintf("feature/%d-thing", number+1000), "baseRefName": base, "isCrossRepository": false,
		"mergedAt": mergedAt.UTC().Format(time.RFC3339), "updatedAt": mergedAt.UTC().Format(time.RFC3339),
		"body": "", "author": map[string]any{"login": "ag"}, "mergedBy": map[string]any{"login": "boss"},
		"mergeCommit":             map[string]any{"oid": fmt.Sprintf("%040x", number), "parents": map[string]any{"totalCount": 1}},
		"latestReviews":           map[string]any{"nodes": []any{map[string]any{"author": map[string]any{"login": "rev"}}}},
		"closingIssuesReferences": map[string]any{"nodes": []any{}},
	}
	for k, v := range extra {
		pr[k] = v
	}
	// The newest update first, as GitHub orders the page.
	g.prs = append([]map[string]any{pr}, g.prs...)
}

func argValue(args []string, name string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func (g *historyGh) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return plainRunner(ctx, dir, name, args...)
	}
	if args[0] == "repo" {
		return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
	}
	if args[0] != "api" || args[1] != "graphql" {
		return []byte(`[]`), nil
	}
	query := argValue(args, "query")
	if g.noType && strings.Contains(query, "issueType") {
		return []byte(`{"errors":[{"message":"Field 'issueType' doesn't exist on type 'Issue'"}]}`), errors.New("gh: Field 'issueType' doesn't exist")
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	if strings.Contains(query, "pullRequests(") {
		g.pages.Add(1)
		start := 0
		if after := argValue(args, "after"); after != "" {
			start, _ = strconv.Atoi(after)
		}
		end := min(len(g.prs), start+mergedHistoryPage)
		page := map[string]any{"totalCount": len(g.prs), "pageInfo": map[string]any{"hasNextPage": end < len(g.prs), "endCursor": strconv.Itoa(end)}, "nodes": g.prs[start:end]}
		return json.Marshal(map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequests": page}}})
	}
	g.tix.Add(1)
	repo := map[string]any{}
	for _, m := range historyAliasRe.FindAllStringSubmatch(query, -1) {
		n, _ := strconv.Atoi(m[1])
		issue := map[string]any{"number": n, "title": fmt.Sprintf("ticket %d", n), "url": fmt.Sprintf("https://github.com/acme/app/issues/%d", n), "milestone": map[string]any{"title": "1.0.0"}}
		if strings.Contains(query, "issueType") {
			issue["issueType"] = map[string]any{"name": "Story"}
		}
		repo["t"+m[1]] = issue
	}
	return json.Marshal(map[string]any{"data": map[string]any{"repository": repo}})
}

func historyReviews(t *testing.T, gh *historyGh) (*Reviews, string, *atomic.Int64) {
	dir := makeGitFlowRepo(t)
	os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(reviewsSfManifest), 0644)
	collector := MakeCollector("", gh.run, nil)
	reviews := MakeReviews(collector, gh.run, nil)
	deadline := time.Now().Add(time.Minute)
	for {
		snap, err := collector.Get(dir, time.Hour, false)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Github != nil && !snap.Refreshing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the collector never read GitHub")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var later atomic.Int64
	reviews.now = func() time.Time { return time.Now().Add(time.Duration(later.Load())) }
	t.Cleanup(func() { waitHistoryIdle(t, reviews, filepath.Clean(dir)) })
	return reviews, dir, &later
}

func waitHistoryIdle(t *testing.T, r *Reviews, dir string) {
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		r.lock.Lock()
		state := r.history[dir]
		loading := state != nil && state.loading
		r.lock.Unlock()
		if !loading {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("the merged history read never ended")
}

// readHistoryTo asks until the read in progress ended; the first ask starts it.
func readHistoryTo(t *testing.T, r *Reviews, dir string, force bool) MergedHistoryAnswer {
	t.Helper()
	answer, err := r.MergedHistory(MergedHistoryRequest{Dir: dir, Force: force})
	if err != nil {
		t.Fatal(err)
	}
	waitHistoryIdle(t, r, filepath.Clean(dir))
	answer, err = r.MergedHistory(MergedHistoryRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return answer
}

// AC2: every PR merged into the target, page after page, newest merge first, with its ticket.
func TestMergedHistoryReadsEveryPage(t *testing.T) {
	gh := &historyGh{}
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	for i := 1; i <= 230; i++ {
		gh.add(i, "develop", base.Add(time.Duration(i)*time.Hour), nil)
	}
	gh.add(231, "main", base.Add(300*time.Hour), nil)
	gh.add(232, "develop", base.Add(301*time.Hour), map[string]any{"isCrossRepository": true})
	gh.add(233, "develop", base.Add(302*time.Hour), map[string]any{
		"closingIssuesReferences": map[string]any{"nodes": []any{map[string]any{"number": 77, "title": "the ticket", "url": "https://github.com/acme/app/issues/77",
			"issueType": map[string]any{"name": "Bug"}, "milestone": map[string]any{"title": "1.1.0"}}}},
		"mergeCommit": map[string]any{"oid": fmt.Sprintf("%040x", 233), "parents": map[string]any{"totalCount": 2}},
		"body":        "work\n\n<!-- molten:agents -->\n",
	})
	reviews, dir, _ := historyReviews(t, gh)
	answer := readHistoryTo(t, reviews, dir, false)
	if answer.Error != "" || !answer.Complete || answer.Loading {
		t.Fatalf("answer: error %q complete %v loading %v", answer.Error, answer.Complete, answer.Loading)
	}
	if len(answer.Prs) != 231 || answer.Total != 233 || gh.pages.Load() != 3 {
		t.Fatalf("%d PRs of %d in %d pages", len(answer.Prs), answer.Total, gh.pages.Load())
	}
	first := answer.Prs[0]
	if first.Number != 233 || first.Ticket != 77 || first.TicketTitle != "the ticket" || first.TicketType != "Bug" || first.Milestone != "1.1.0" || first.MergeMethod != MergeMethodMerge {
		t.Fatalf("first: %+v", first)
	}
	last := answer.Prs[len(answer.Prs)-1]
	if last.Number != 1 || last.Ticket != 1001 || last.TicketFrom != ReviewTicketFromBranch || last.TicketTitle != "ticket 1001" || last.TicketType != "Story" || last.Milestone != "1.0.0" {
		t.Fatalf("last: %+v", last)
	}
	if last.MergeMethod != MergeMethodLinear || len(last.Reviewers) != 1 || last.Reviewers[0] != "rev" || last.MergedBy != "boss" {
		t.Fatalf("last: %+v", last)
	}
	if gh.tix.Load() != 5 {
		t.Fatalf("230 tickets by branch read in %d queries", gh.tix.Load())
	}
}

// AC5: a complete history is kept; asked again later, only its newest page is read, and new PRs join it.
func TestMergedHistoryRefreshReadsTheNewestPages(t *testing.T) {
	gh := &historyGh{}
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	for i := 1; i <= 150; i++ {
		gh.add(i, "develop", base.Add(time.Duration(i)*time.Hour), nil)
	}
	reviews, dir, later := historyReviews(t, gh)
	answer := readHistoryTo(t, reviews, dir, false)
	if len(answer.Prs) != 150 || gh.pages.Load() != 2 {
		t.Fatalf("%d PRs in %d pages", len(answer.Prs), gh.pages.Load())
	}
	answer = readHistoryTo(t, reviews, dir, false)
	if gh.pages.Load() != 2 {
		t.Fatal("a fresh history is not read again")
	}
	gh.add(151, "develop", base.Add(200*time.Hour), nil)
	later.Store(int64(3 * time.Minute))
	answer = readHistoryTo(t, reviews, dir, false)
	if len(answer.Prs) != 151 || answer.Prs[0].Number != 151 || gh.pages.Load() != 3 {
		t.Fatalf("%d PRs, first #%d, %d pages", len(answer.Prs), answer.Prs[0].Number, gh.pages.Load())
	}
	answer = readHistoryTo(t, reviews, dir, true)
	if len(answer.Prs) != 151 || gh.pages.Load() != 4 {
		t.Fatalf("refresh: %d PRs, %d pages", len(answer.Prs), gh.pages.Load())
	}
}

// A GitHub without issue types still gives the history, its tickets without a type.
func TestMergedHistoryWithoutIssueTypes(t *testing.T) {
	gh := &historyGh{noType: true}
	gh.add(1, "develop", time.Now().Add(-time.Hour), nil)
	reviews, dir, _ := historyReviews(t, gh)
	answer := readHistoryTo(t, reviews, dir, false)
	if answer.Error != "" || len(answer.Prs) != 1 || answer.Prs[0].TicketTitle != "ticket 1001" || answer.Prs[0].TicketType != "" {
		t.Fatalf("answer: %+v", answer)
	}
}

func TestSortReleaseTags(t *testing.T) {
	got := SortReleaseTags([]string{"v1.0.0", "v1.0.0-10", "v1.0.0-2", "v0.9.0", "nightly", "v1.0.0-rc.1", "v1.1.0-1", "v1.0.1"}, "v")
	want := "v0.9.0,v1.0.0-2,v1.0.0-10,v1.0.0-rc.1,v1.0.0,v1.0.1,v1.1.0-1,nightly"
	if strings.Join(got, ",") != want {
		t.Fatalf("got %v", got)
	}
}

// AC2, AC4: where each merge commit ships, for the whole history at once, as ReadShips says it for one.
func TestReadHistoryShips(t *testing.T) {
	dir := makeGitFlowRepo(t)
	oidOf := func() string { return gitIn(t, dir, "rev-parse", "HEAD") }
	first := gitIn(t, dir, "rev-parse", "v1.1.0-1^{commit}")
	commit(t, dir, "e.txt", "fix(#5): shipped on main")
	onMain := oidOf()
	gitRun(t, dir, "checkout", "-q", "main")
	gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "release", "develop")
	gitRun(t, dir, "checkout", "-q", "develop")
	commit(t, dir, "f.txt", "fix(#6): next")
	next := oidOf()
	missing := "0123456789abcdef0123456789abcdef01234567"
	ctx := context.Background()
	tags, ships := ReadHistoryShips(ctx, plainRunner, dir, []string{first, onMain, next, missing}, "v", "main", "develop")
	if strings.Join(tags, ",") != "v1.0.0,v1.1.0-1" {
		t.Fatalf("tags: %v", tags)
	}
	check := func(oid string, where string, in string) {
		t.Helper()
		ship, ok := ships[oid]
		if !ok || ship.ships != where || ship.in != in {
			t.Fatalf("%s ships %+v (%v), want %s %s", oid, ship, ok, where, in)
		}
	}
	check(first, ReviewShipsTag, "v1.1.0-1")
	check(onMain, ReviewShipsBranch, "main")
	check(next, ReviewShipsNext, "")
	if _, ok := ships[missing]; ok {
		t.Fatal("a commit the clone lacks has no answer")
	}
	gitRun(t, dir, "tag", "v1.1.0-2", next)
	// The release cut later carries both: each still ships in the candidate that carried it first.
	gitRun(t, dir, "tag", "v1.1.0", next)
	tags, ships = ReadHistoryShips(ctx, plainRunner, dir, []string{first, next}, "v", "main", "develop")
	if strings.Join(tags, ",") != "v1.0.0,v1.1.0-1,v1.1.0-2,v1.1.0" {
		t.Fatalf("tags: %v", tags)
	}
	check(first, ReviewShipsTag, "v1.1.0-1")
	check(next, ReviewShipsTag, "v1.1.0-2")
	if where, in, _ := ReadShips(ctx, plainRunner, dir, next, "v", "main"); where != ReviewShipsTag || in != "v1.1.0-2" {
		t.Fatalf("Recently merged says %s %s", where, in)
	}
	noTags, ships := ReadHistoryShips(ctx, plainRunner, dir, []string{next}, "release-", "", "develop")
	if len(noTags) != 0 {
		t.Fatalf("no tag of that prefix: %v", noTags)
	}
	check(next, ReviewShipsNext, "")
}
