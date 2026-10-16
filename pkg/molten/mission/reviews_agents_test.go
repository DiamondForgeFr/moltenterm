// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
)

var signJerome = agentsign.Signature{FirstName: "Jérôme", Agent: "Codex", Model: "gpt-5.5-codex", Effort: "high"}
var signValentin = agentsign.Signature{FirstName: "Valentin", Agent: "Claude Code", Model: "Opus 5.5", Effort: "medium"}

func signedPrs(t *testing.T) string {
	t.Helper()
	body, _ := json.Marshal(agentsign.WithAgent("Resolves #7", signJerome))
	return `[
 {"number":10,"title":"signed","headRefName":"feature/7-a","baseRefName":"develop","updatedAt":"2026-10-10T10:00:00Z","body":` + string(body) + `},
 {"number":11,"title":"unsigned","headRefName":"feature/8-b","baseRefName":"develop","updatedAt":"2026-10-11T10:00:00Z","body":"Resolves #8"}
]`
}

func agentLines(agents []agentsign.Signature) string {
	var lines []string
	for _, a := range agents {
		lines = append(lines, a.Line())
	}
	return strings.Join(lines, " | ")
}

func TestReviewsAgentsFromBodyThenCommits(t *testing.T) {
	dir := reviewsProject(t, reviewsSfManifest)
	answer := BuildReviews(reviewsSnapshot(dir, signedPrs(t)))
	byNumber := map[int]ReviewPr{}
	for _, pr := range answer.Ready {
		byNumber[pr.Number] = pr
	}
	if got := agentLines(byNumber[10].Agents); got != signJerome.Line() {
		t.Fatalf("body block before the commits are read: %q", got)
	}
	if len(byNumber[11].Agents) != 0 {
		t.Fatalf("no signature: unknown agent: %+v", byNumber[11].Agents)
	}

	var query string
	run := func(ctx context.Context, d string, name string, a ...string) ([]byte, error) {
		query = strings.Join(a, " ")
		return []byte(`{"data":{"repository":{
			"p10":{"title":"signed","comments":{"nodes":[]},"commits":{"nodes":[
				{"commit":{"message":"feat(#7): one\n\nMolten-Agent: Jérôme (Codex, gpt-5.5-codex, high)"}},
				{"commit":{"message":"feat(#7): two\n\nMolten-Agent: Valentin (Claude Code, Opus 5.5, medium)\nCo-Authored-By: x"}}]}},
			"p11":{"title":"unsigned","comments":{"nodes":[]},"commits":{"nodes":[{"commit":{"message":"fix: by hand"}}]}}
		}}}`), nil
	}
	reviews := MakeReviews(nil, run, nil)
	reviews.now = func() time.Time { return time.Unix(1_000_000, 0) }
	got := answer
	if !reviews.prepareReports(&got, false) {
		t.Fatal("the reports query starts")
	}
	repoRef, prs := reviews.takeQuery(dir)
	reports, tickets, commits, err := readReviewFacts(context.Background(), run, dir, repoRef, prs)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(query, "commits(last:30){nodes{commit{message}}}") {
		t.Fatalf("query reads the commits: %s", query)
	}
	reviews.storeCommits(dir, commits)
	reviews.storeReports(dir, reports, tickets, "")
	again := BuildReviews(reviewsSnapshot(dir, signedPrs(t)))
	reviews.applyKnownReports(&again)
	for _, pr := range again.Ready {
		byNumber[pr.Number] = pr
	}
	if got := agentLines(byNumber[10].Agents); got != signValentin.Line()+" | "+signJerome.Line() {
		t.Fatalf("the latest commit's trailer leads: %q", got)
	}
	if len(byNumber[11].Agents) != 0 {
		t.Fatalf("still unknown: %+v", byNumber[11].Agents)
	}
}
