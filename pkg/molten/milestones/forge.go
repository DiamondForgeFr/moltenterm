// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The forge as the user's gh reads it in the project's folder: the repository is the one gh resolves there (its default
// repository first, as every other gh call of MoltenTerm). Two calls per read: the open milestones, then the open
// tickets of the active one, newest update first.

const (
	// One page of the forge's API: a project with more open tickets in one milestone counts the rest from the
	// milestone's own count.
	maxTickets = 100
	// More open milestones than this would be one page more; the active one is among the first hundred the forge lists.
	maxMilestones = 100
)

var milestoneUrlRegex = regexp.MustCompile(`^(https://[^/\s]+/[^/\s]+/[^/\s]+)/milestone/\d+$`)

type forgeMilestone struct {
	Number       int    `json:"number"`
	Title        string `json:"title"`
	HtmlUrl      string `json:"html_url"`
	OpenIssues   int    `json:"open_issues"`
	ClosedIssues int    `json:"closed_issues"`
	DueOn        string `json:"due_on"`
	UpdatedAt    string `json:"updated_at"`
}

type forgeIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HtmlUrl     string          `json:"html_url"`
	Body        string          `json:"body"`
	UpdatedAt   string          `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t
}

// before orders the open milestones, the active one first (#2392): those with open tickets left before the others;
// then the nearest due date, the earliest, an overdue one included since it is still the one to finish; with no due
// date, the most recent activity; dated milestones come before undated ones.
func before(a *forgeMilestone, b *forgeMilestone) bool {
	if (a.OpenIssues > 0) != (b.OpenIssues > 0) {
		return a.OpenIssues > 0
	}
	ad, bd := parseTime(a.DueOn), parseTime(b.DueOn)
	if ad.IsZero() != bd.IsZero() {
		return !ad.IsZero()
	}
	if !ad.Equal(bd) {
		return ad.Before(bd)
	}
	au, bu := parseTime(a.UpdatedAt), parseTime(b.UpdatedAt)
	if !au.Equal(bu) {
		return au.After(bu)
	}
	return a.Number < b.Number
}

// pickActive is the project's active milestone among its open ones; nil when there is none.
func pickActive(list []forgeMilestone) *forgeMilestone {
	var best *forgeMilestone
	for i := range list {
		m := &list[i]
		if m.Number <= 0 {
			continue
		}
		if best == nil || before(m, best) {
			best = m
		}
	}
	return best
}

// repoOf is the repository's web address a milestone's names: the key of its tickets' sentences.
func repoOf(milestoneUrl string) string {
	m := milestoneUrlRegex.FindStringSubmatch(strings.TrimSpace(milestoneUrl))
	if m == nil {
		return ""
	}
	return m[1]
}

func httpsOnly(url string) string {
	if !strings.HasPrefix(url, "https://") || len(url) > 500 {
		return ""
	}
	return url
}

// noForge tells a definite answer (no gh, signed out, no repository gh knows) from a failure worth reading again.
func noForge(err error) bool {
	msg := strings.ToLower(err.Error())
	for _, word := range []string{
		"not installed", "executable file not found", "gh auth login", "not logged", "authentication",
		"no git remotes", "none of the git remotes", "not a git repository", "http 404", "could not resolve to a repository",
	} {
		if strings.Contains(msg, word) {
			return true
		}
	}
	return false
}

func readForge(ctx context.Context, gh func(ctx context.Context, dir string, args ...string) ([]byte, error), dir string) readResult {
	if gh == nil {
		return readResult{state: StateNoForge}
	}
	out, err := gh(ctx, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/milestones?state=open&per_page=%d", maxMilestones))
	if err != nil {
		if noForge(err) {
			return readResult{state: StateNoForge, err: err}
		}
		return readResult{err: err}
	}
	var list []forgeMilestone
	if err := json.Unmarshal(out, &list); err != nil {
		return readResult{err: errors.New("gh api milestones: unreadable answer")}
	}
	active := pickActive(list)
	if active == nil {
		return readResult{state: StateNone}
	}
	m := &Milestone{
		Number: active.Number,
		Title:  cutRunes(oneLine(active.Title), maxTitleRunes),
		Url:    httpsOnly(active.HtmlUrl),
		Open:   max(0, active.OpenIssues),
		Closed: max(0, active.ClosedIssues),
		Due:    unixMs(parseTime(active.DueOn)),
	}
	m.Tickets = []Ticket{}
	if active.OpenIssues > 0 {
		out, err = gh(ctx, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=open&sort=updated&direction=desc&per_page=%d", active.Number, maxTickets))
		if err != nil {
			return readResult{err: err}
		}
		var issues []forgeIssue
		if err := json.Unmarshal(out, &issues); err != nil {
			return readResult{err: errors.New("gh api issues: unreadable answer")}
		}
		for _, issue := range issues {
			if issue.Number <= 0 || (len(issue.PullRequest) > 0 && string(issue.PullRequest) != "null") {
				continue
			}
			m.Tickets = append(m.Tickets, Ticket{
				Number:  issue.Number,
				Title:   cutRunes(oneLine(issue.Title), maxTitleRunes),
				Url:     httpsOnly(issue.HtmlUrl),
				Updated: unixMs(parseTime(issue.UpdatedAt)),
				excerpt: cleanExcerpt(issue.Body),
			})
		}
		m.Remaining = len(m.Tickets)
		if len(issues) >= maxTickets {
			m.Remaining = max(m.Remaining, active.OpenIssues)
		}
	}
	return readResult{state: StateOk, repo: repoOf(active.HtmlUrl), milestone: m}
}
