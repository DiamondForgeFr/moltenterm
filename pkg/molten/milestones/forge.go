// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The forge as the user's gh reads it in the project's folder: the repository is the one gh resolves there (its default
// repository first, as every other gh call of MoltenTerm). Two calls per read: the open milestones with their counts of
// issues (GraphQL counts issues apart from pull requests, where the REST milestone mixes both), then the open issues of
// the active one, newest update first.

const (
	// One page of the forge's API: a project with more open tickets in one milestone counts the rest from the
	// milestone's own count.
	maxTickets = 100
	// More open milestones than this would be one page more; the active one is among the first hundred the forge lists.
	maxMilestones = 100
	// A milestone overdue by more than this is left behind: it loses to every milestone that is not.
	staleOverdue = 60 * 24 * time.Hour
)

// milestonesQuery lists the open milestones and, for each, its open and closed issues alone (#2392).
var milestonesQuery = fmt.Sprintf(`query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    milestones(first: %d, states: OPEN) {
      nodes { number title url dueOn updatedAt open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }
    }
  }
}`, maxMilestones)

var milestoneUrlRegex = regexp.MustCompile(`^(https://[^/\s]+/[^/\s]+/[^/\s]+)/milestone/\d+$`)

type issueCount struct {
	TotalCount int `json:"totalCount"`
}

type forgeMilestone struct {
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	Url       string     `json:"url"`
	DueOn     string     `json:"dueOn"`
	UpdatedAt string     `json:"updatedAt"`
	Open      issueCount `json:"open"`
	Closed    issueCount `json:"closed"`
}

type milestonesAnswer struct {
	Data struct {
		Repository *struct {
			Milestones struct {
				Nodes []forgeMilestone `json:"nodes"`
			} `json:"milestones"`
		} `json:"repository"`
	} `json:"data"`
}

type forgeIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HtmlUrl     string          `json:"html_url"`
	Body        string          `json:"body"`
	PullRequest json.RawMessage `json:"pull_request"`
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t
}

// The active milestone (#2392), the first of this order among the open ones:
//  1. one with open issues left comes before one with none;
//  2. one overdue by more than 60 days comes after every other (a forgotten milestone is not the one at work);
//  3. a dated one comes before an undated one;
//  4. the nearest due date: the earliest, a recently overdue one included, since it is still the one to finish;
//  5. the most recent activity (its last update);
//  6. the lowest number.
func before(a *forgeMilestone, b *forgeMilestone, now time.Time) bool {
	if (a.Open.TotalCount > 0) != (b.Open.TotalCount > 0) {
		return a.Open.TotalCount > 0
	}
	ad, bd := parseTime(a.DueOn), parseTime(b.DueOn)
	aStale, bStale := stale(ad, now), stale(bd, now)
	if aStale != bStale {
		return !aStale
	}
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

func stale(due time.Time, now time.Time) bool {
	return !due.IsZero() && now.Sub(due) > staleOverdue
}

// pickActive is the project's active milestone among its open ones; nil when there is none.
func pickActive(list []forgeMilestone, now time.Time) *forgeMilestone {
	var best *forgeMilestone
	for i := range list {
		m := &list[i]
		if m.Number <= 0 {
			continue
		}
		if best == nil || before(m, best, now) {
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

// contentHash keys a ticket's sentence (#2392): what is sent to the model, its cleaned title and excerpt. A comment, a
// label or a move changes the ticket's update time, not this: its sentence is not written again.
func contentHash(title string, excerpt string) string {
	sum := sha256.Sum256([]byte(cleanTitle(title) + "\n" + excerpt))
	return hex.EncodeToString(sum[:16])
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

type ghFunc func(ctx context.Context, dir string, args ...string) ([]byte, error)

func openMilestones(ctx context.Context, gh ghFunc, dir string) ([]forgeMilestone, error) {
	out, err := gh(ctx, dir, "api", "graphql", "-f", "query="+milestonesQuery, "-F", "owner={owner}", "-F", "name={repo}")
	if err != nil {
		return nil, err
	}
	var answer milestonesAnswer
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil, errors.New("gh api graphql milestones: unreadable answer")
	}
	if answer.Data.Repository == nil {
		return nil, errors.New("gh api graphql milestones: could not resolve to a repository")
	}
	return answer.Data.Repository.Milestones.Nodes, nil
}

func readForge(ctx context.Context, gh ghFunc, dir string, now time.Time) readResult {
	if gh == nil {
		return readResult{state: StateNoForge}
	}
	list, err := openMilestones(ctx, gh, dir)
	if err != nil {
		if noForge(err) {
			return readResult{state: StateNoForge, err: err}
		}
		return readResult{err: err}
	}
	active := pickActive(list, now)
	if active == nil {
		return readResult{state: StateNone}
	}
	m := &Milestone{
		Number:    active.Number,
		Title:     cutRunes(oneLine(active.Title), maxTitleRunes),
		Url:       httpsOnly(active.Url),
		Open:      max(0, active.Open.TotalCount),
		Closed:    max(0, active.Closed.TotalCount),
		Due:       unixMs(parseTime(active.DueOn)),
		Remaining: max(0, active.Open.TotalCount),
		Tickets:   []Ticket{},
	}
	if active.Open.TotalCount > 0 {
		out, err := gh(ctx, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=open&sort=updated&direction=desc&per_page=%d", active.Number, maxTickets))
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
			title := cutRunes(oneLine(issue.Title), maxTitleRunes)
			excerpt := cleanExcerpt(issue.Body)
			m.Tickets = append(m.Tickets, Ticket{
				Number:  issue.Number,
				Title:   title,
				Url:     httpsOnly(issue.HtmlUrl),
				excerpt: excerpt,
				hash:    contentHash(title, excerpt),
			})
		}
		m.Remaining = max(m.Remaining, len(m.Tickets))
	}
	return readResult{state: StateOk, repo: repoOf(active.Url), milestone: m}
}
