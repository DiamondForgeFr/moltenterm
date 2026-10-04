// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRedactBugText(t *testing.T) {
	in := strings.Join([]string{
		"token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"curl -H 'Authorization: Bearer abcdefghijklmnop'",
		"run --token=s3cr3t --verbose",
		"OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
		"https://x.test/cb?access_token=zzz&ok=1",
		"mail anthony@example.com",
		"at /Users/anthony/Projects/app/main.go:12",
	}, "\n")
	out := RedactBugText(in)
	for _, leak := range []string{"ghp_abc", "abcdefghijklmnop'", "s3cr3t", "sk-abc", "zzz", "anthony@", "/Users/anthony/"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q leaked:\n%s", leak, out)
		}
	}
	for _, kept := range []string{"--verbose", "ok=1", "/Users/<user>/Projects/app/main.go:12", "<email>"} {
		if !strings.Contains(out, kept) {
			t.Errorf("%q lost:\n%s", kept, out)
		}
	}
}

func TestBugAdvice(t *testing.T) {
	build, _ := ParseBuildTime("202610011200")
	cases := []struct {
		issue BugIssue
		want  string
	}{
		{BugIssue{Number: 1, State: "open"}, BugAdviceComment},
		{BugIssue{Number: 2, State: "closed", StateReason: "completed", ClosedAt: "2026-10-03T09:00:00Z"}, BugAdviceUpdate},
		{BugIssue{Number: 3, State: "closed", StateReason: "completed", ClosedAt: "2026-09-20T09:00:00Z"}, BugAdviceRegression},
		{BugIssue{Number: 4, State: "closed", StateReason: "not_planned", ClosedAt: "2026-10-03T09:00:00Z"}, BugAdviceNotPlanned},
	}
	for _, c := range cases {
		if got, _ := BugAdvice(c.issue, build, true); got != c.want {
			t.Errorf("#%d: got %s want %s", c.issue.Number, got, c.want)
		}
	}
	if got, _ := BugAdvice(BugIssue{State: "closed", ClosedAt: "2026-10-03T09:00:00Z"}, time.Time{}, false); got != BugAdviceRegression {
		t.Errorf("a dev build without build time: %s", got)
	}
}

func TestDuplicatesAreCloseOpenTitles(t *testing.T) {
	if s := TitleSimilarity("Timeline header buttons wrap on two lines", "The Timeline header's buttons wrap"); s < BugDuplicateSimilarity {
		t.Errorf("same bug: %f", s)
	}
	if s := TitleSimilarity("Timeline header buttons wrap", "Notification bell shows no count"); s != 0 {
		t.Errorf("different bugs: %f", s)
	}
	matches := MatchBugIssues("Timeline header buttons wrap", []BugIssue{
		{Number: 7, Title: "Notification bell count", State: "open"},
		{Number: 9, Title: "Timeline header buttons wrap on narrow panes", State: "open"},
		{Number: 5, Title: "Timeline header buttons wrap", State: "closed", ClosedAt: "2026-01-01T00:00:00Z"},
	}, time.Time{}, false)
	if matches[0].Number != 5 || matches[1].Number != 9 {
		t.Fatalf("closest first: %+v", matches)
	}
	dups := OpenDuplicates(matches)
	if len(dups) != 1 || dups[0].Number != 9 {
		t.Fatalf("only the close open issue is a duplicate: %+v", dups)
	}
}

func TestBugReportBodyAndUrl(t *testing.T) {
	env := BugEnvironment{Version: "0.14.5", BuildTime: "202610041015", Os: "darwin", Arch: "arm64"}
	body := BugReportBody(BugReport{Title: "t", What: "It crashed in /Users/anthony/x", Expected: "No crash", Steps: "1. Open", Regression: 12}, env)
	for _, want := range []string{"## What happened", "/Users/<user>/x", "## Expected", "## Steps to reproduce", "#12 again", "MoltenTerm 0.14.5 (built 2026-10-04 10:15)", "darwin arm64"} {
		if !strings.Contains(body, want) {
			t.Errorf("body misses %q:\n%s", want, body)
		}
	}
	link := NewIssueUrl(BugRepo, "A bug", strings.Repeat("long text ", 2000), []string{BugLabel, BugAgentLabel})
	if len(link) > maxIssueUrlLength {
		t.Fatalf("too long: %d", len(link))
	}
	parsed, _ := url.Parse(link)
	q := parsed.Query()
	if parsed.Path != "/DiamondForgeFr/moltenterm/issues/new" || q.Get("title") != "A bug" || q.Get("labels") != "bug,reported-from-moltenterm" || !strings.Contains(q.Get("body"), "shortened to fit") {
		t.Fatalf("url: %s", link)
	}
	if !strings.Contains(BugCommentBody("again with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", env), "<github-token>") {
		t.Fatal("comments are redacted too")
	}
}
