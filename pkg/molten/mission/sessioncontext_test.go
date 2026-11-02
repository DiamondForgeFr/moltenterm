// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"regexp"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func sessionGithub() *GithubSnapshot {
	return &GithubSnapshot{
		Repo: "acme/app",
		Prs: json.RawMessage(`[{"number":12,"title":"Open one","url":"https://github.com/acme/app/pull/12","headRefName":"feature/10-open","isDraft":false},
			{"number":13,"title":"Draft one","url":"https://github.com/acme/app/pull/13","headRefName":"feature/11-draft","isDraft":true}]`),
		Merged: json.RawMessage(`[{"number":9,"title":"Merged one","url":"https://github.com/acme/app/pull/9","headRefName":"fix/8-done","mergedAt":"2026-10-20T10:00:00Z"},
			{"number":14,"title":"Closed one","url":"https://github.com/acme/app/pull/14","headRefName":"fix/15-dropped","state":"CLOSED"}]`),
	}
}

func defaultTicketOf(branch string) int {
	return ticketOfBranch(branch, []*regexp.Regexp{defaultTicketBranchRe})
}

func TestResolveSessionContextByBranch(t *testing.T) {
	gh := sessionGithub()
	cases := []struct {
		branch string
		pr     int
		state  string
		ticket int
	}{
		{"feature/10-open", 12, molten.SessionPrOpen, 10},
		{"feature/11-draft", 13, molten.SessionPrDraft, 11},
		{"fix/8-done", 9, molten.SessionPrMerged, 8},
		{"feature/77-none", 0, "", 77},
		// A PR closed without merging is in the same read (#1088): never called merged.
		{"fix/15-dropped", 0, "", 15},
	}
	for _, c := range cases {
		ctx := ResolveSessionContext(molten.SessionContextQuery{Project: "/p", Branch: c.branch}, gh, defaultTicketOf)
		if ctx.Pr != c.pr || ctx.PrState != c.state || ctx.Ticket != c.ticket || ctx.Repo != "acme/app" {
			t.Fatalf("%s: %+v", c.branch, ctx)
		}
	}
}

func TestResolveSessionContextByOriginNumber(t *testing.T) {
	gh := sessionGithub()
	ctx := ResolveSessionContext(molten.SessionContextQuery{Branch: "whatever", Repo: "acme/app", Number: 9}, gh, nil)
	if ctx.Pr != 9 || ctx.PrState != molten.SessionPrMerged || ctx.PrTitle != "Merged one" {
		t.Fatalf("merged by number: %+v", ctx)
	}
	// A PR the cache does not know (closed, or older than the merged list) keeps its number and a link, no state.
	ctx = ResolveSessionContext(molten.SessionContextQuery{Repo: "acme/app", Number: 5}, gh, nil)
	if ctx.Pr != 5 || ctx.PrState != "" || ctx.PrUrl != "https://github.com/acme/app/pull/5" {
		t.Fatalf("unknown PR: %+v", ctx)
	}
	// Another repository's PR is never matched against this project's numbers.
	ctx = ResolveSessionContext(molten.SessionContextQuery{Repo: "other/repo", Number: 12}, gh, nil)
	if ctx.PrState != "" || ctx.Repo != "other/repo" {
		t.Fatalf("other repository: %+v", ctx)
	}
}

func TestResolveSessionContextWithoutCache(t *testing.T) {
	ctx := ResolveSessionContext(molten.SessionContextQuery{Branch: "fix/42-thing"}, nil, defaultTicketOf)
	if ctx.Ticket != 42 || ctx.Pr != 0 || ctx.PrUrl != "" {
		t.Fatalf("no cache: %+v", ctx)
	}
}
