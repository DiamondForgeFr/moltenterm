// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mergedPrJson(number int, base string, mergedAt time.Time, oid string) string {
	return fmt.Sprintf(`{"number":%d,"title":"pr %d","url":"https://github.com/acme/app/pull/%d","headRefName":"fix/%d-x","baseRefName":%q,`+
		`"mergedAt":%q,"author":{"login":"ag"},"mergedBy":{"login":"boss"},"mergeCommit":{"oid":%q}}`,
		number, number, number, number+100, base, mergedAt.UTC().Format(time.RFC3339), oid)
}

func mergedNumbers(prs []ReviewMergedPr) []int {
	rtn := []int{}
	for _, pr := range prs {
		rtn = append(rtn, pr.Number)
	}
	return rtn
}

// AC2: the window's PRs into the target only, newest first, at most 20.
func TestBuildMergedKeepsTheWindow(t *testing.T) {
	readAt := time.Date(2026, 10, 16, 18, 0, 0, 0, time.UTC)
	rows := []string{
		mergedPrJson(1, "develop", readAt.Add(-time.Hour), "aaaaaaa"),
		mergedPrJson(2, "develop", readAt.Add(-8*24*time.Hour), "bbbbbbb"),
		mergedPrJson(3, "main", readAt.Add(-2*time.Hour), "ccccccc"),
		mergedPrJson(4, "develop", readAt.Add(-3*24*time.Hour), "not an oid"),
		mergedPrJson(5, "develop", readAt.Add(-30*time.Minute), "ddddddd"),
	}
	got, err := buildMerged(json.RawMessage("["+strings.Join(rows, ",")+"]"), "develop", readAt.UnixMilli(), branchTicketRes(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(mergedNumbers(got), []int{5, 1, 4}) {
		t.Fatalf("merged rows: %v", mergedNumbers(got))
	}
	first := got[0]
	if first.Author != "ag" || first.MergedBy != "boss" || first.MergeOid != "ddddddd" || first.Ticket != 105 || first.TicketFrom != ReviewTicketFromBranch {
		t.Fatalf("row: %+v", first)
	}
	if got[2].MergeOid != "" {
		t.Fatal("an oid that is not one is never passed to git")
	}
	many := []string{}
	for i := 0; i < 25; i++ {
		many = append(many, mergedPrJson(i+1, "develop", readAt.Add(-time.Duration(i)*time.Minute), "aaaaaaa"))
	}
	got, _ = buildMerged(json.RawMessage("["+strings.Join(many, ",")+"]"), "develop", readAt.UnixMilli(), nil)
	if len(got) != ReviewMergedMax || got[0].Number != 1 {
		t.Fatalf("capped at %d: %v", ReviewMergedMax, mergedNumbers(got))
	}
}

func TestMergedPrsArgsNameTheTarget(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	args := strings.Join(mergedPrsArgs(dir, time.Date(2026, 10, 16, 1, 0, 0, 0, time.UTC)), " ")
	if !strings.Contains(args, "--state merged") || !strings.Contains(args, "merged:>=2026-10-08") || !strings.Contains(args, "--base develop") {
		t.Fatalf("args: %s", args)
	}
}

// AC1: a merge commit no tag carries ships with the next release; the release branch, then a tag, carry it.
func TestReadShips(t *testing.T) {
	dir := makeGitFlowRepo(t)
	commit(t, dir, "e.txt", "fix(#5): merged an hour ago")
	oid := gitIn(t, dir, "rev-parse", "HEAD")
	ctx := context.Background()
	check := func(wantShips, wantIn string) {
		t.Helper()
		ships, in, ok := ReadShips(ctx, plainRunner, dir, oid, "v", "main")
		if !ok || ships != wantShips || in != wantIn {
			t.Fatalf("ships %q in %q (ok %v), want %q in %q", ships, in, ok, wantShips, wantIn)
		}
	}
	check(ReviewShipsNext, "")
	gitRun(t, dir, "checkout", "-q", "main")
	gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "release", "develop")
	check(ReviewShipsBranch, "main")
	gitRun(t, dir, "tag", "v1.0.0-4")
	gitRun(t, dir, "tag", "v1.0.0-5")
	check(ReviewShipsTag, "v1.0.0-4")
	if _, _, ok := ReadShips(ctx, plainRunner, dir, "0123456789abcdef0123456789abcdef01234567", "v", "main"); ok {
		t.Fatal("a commit the clone lacks has no answer")
	}
}

// The view's ask reads where the merged PRs ship in the background and publishes it; a tag found is kept.
func TestReviewsGetReadsShips(t *testing.T) {
	dir := makeGitFlowRepo(t)
	os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(reviewsSfManifest), 0644)
	commit(t, dir, "e.txt", "fix(#5): merged")
	oid := gitIn(t, dir, "rev-parse", "HEAD")
	merged := "[" + mergedPrJson(7, "develop", time.Now().Add(-time.Hour), oid) + "]"
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name != "gh" {
			return plainRunner(ctx, d, name, args...)
		}
		switch {
		case args[0] == "repo":
			return []byte(`{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}`), nil
		case args[0] == "pr" && strings.Contains(strings.Join(args, " "), "--state merged"):
			return []byte(merged), nil
		}
		return []byte(`[]`), nil
	}
	published := make(chan ReviewsAnswer, 8)
	collector := MakeCollector("", run, nil)
	reviews := MakeReviews(collector, run, func(a ReviewsAnswer) { published <- a })
	var later atomic.Int64
	reviews.now = func() time.Time { return time.Now().Add(time.Duration(later.Load())) }
	t.Cleanup(func() { waitShipsIdle(t, reviews, filepath.Clean(dir)) })
	// Generous: it only bounds a failing run.
	deadline := time.Now().Add(time.Minute)
	waitShips := func(want string) ReviewMergedPr {
		t.Helper()
		for time.Now().Before(deadline) {
			answer, err := reviews.Get(ReviewsRequest{Dir: dir})
			if err != nil {
				t.Fatal(err)
			}
			if len(answer.Merged) == 1 && answer.Merged[0].Ships == want {
				return answer.Merged[0]
			}
			select {
			case <-published:
			case <-time.After(20 * time.Millisecond):
			}
		}
		t.Fatalf("never shipped %q", want)
		return ReviewMergedPr{}
	}
	row := waitShips(ReviewShipsNext)
	if row.Number != 7 || row.MergedBy != "boss" {
		t.Fatalf("row: %+v", row)
	}
	gitRun(t, dir, "tag", "v1.0.0-4")
	later.Store(int64(2 * time.Minute))
	row = waitShips(ReviewShipsTag)
	if row.ShipsIn != "v1.0.0-4" {
		t.Fatalf("tag: %+v", row)
	}
}

// A refresh's forced ask reads the ships before its fetch brings the tags: the refresh's end reads them again.
func TestReviewsRefreshedReadsShipsAfterTheFetch(t *testing.T) {
	dir := makeGitFlowRepo(t)
	os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(reviewsSfManifest), 0644)
	commit(t, dir, "e.txt", "fix(#5): merged")
	oid := gitIn(t, dir, "rev-parse", "HEAD")
	reviews := MakeReviews(MakeCollector("", plainRunner, nil), plainRunner, nil)
	snap := reviewsSnapshot(dir, `[]`)
	snap.GithubAt = time.Now().UnixMilli()
	snap.Github.Merged = json.RawMessage("[" + mergedPrJson(7, "develop", time.Now().Add(-time.Hour), oid) + "]")
	ships := func() string {
		answer := BuildReviews(snap)
		reviews.applyKnownReports(&answer)
		return answer.Merged[0].Ships
	}
	reviews.Refreshed(snap)
	if ships() != "" {
		t.Fatal("no project asked: nothing read")
	}
	answer := BuildReviews(snap)
	if !reviews.prepareShips(&answer, snap, true) {
		t.Fatal("the first ask reads")
	}
	reviews.readShips(dir)
	if ships() != ReviewShipsNext {
		t.Fatalf("before the tag: %q", ships())
	}
	gitRun(t, dir, "tag", "v1.0.0-4")
	reviews.Refreshed(snap)
	if ships() != ReviewShipsNext {
		t.Fatal("no newer git read: the answer stays")
	}
	snap.GitAt = time.Now().Add(time.Second).UnixMilli()
	reviews.Refreshed(snap)
	if ships() != ReviewShipsTag {
		t.Fatalf("after the fetch: %q", ships())
	}
}

func waitShipsIdle(t *testing.T, r *Reviews, dir string) {
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		r.lock.Lock()
		state := r.ships[dir]
		running := state != nil && state.running
		r.lock.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
