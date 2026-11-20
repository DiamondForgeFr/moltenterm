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
// repository first, as every other gh call of MoltenTerm). One call lists the open milestones with their counts of issues
// (GraphQL counts issues apart from pull requests, where the REST milestone mixes both); then one call per milestone
// whose tickets the companion needs: the open issues, newest update first. Those are the first ticketMilestones of the
// tabs' order, and the ones a window selected (#2416): a project with many open milestones does not read them all every
// minute. One last call reads the board status of all those tickets (status.go, #2418).

const (
	// One page of the forge's API: a project with more open tickets in one milestone counts the rest from the
	// milestone's own count.
	maxTickets = 100
	// More open milestones than this would be one page more; the first hundred the forge lists are shown.
	maxMilestones = 100
	// The tabs a companion shows at most (frontend: MaxMilestoneTabs): their tickets are read with every read.
	ticketMilestones = 4
	// The milestones past those whose tickets a window asked for, the least recently asked one leaving first.
	maxSelected = 4
)

// milestonesQuery lists the open milestones and, for each, its open and closed issues alone (#2392).
var milestonesQuery = fmt.Sprintf(`query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    milestones(first: %d, states: OPEN) {
      nodes { number title url dueOn open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }
    }
  }
}`, maxMilestones)

var milestoneUrlRegex = regexp.MustCompile(`^(https://[^/\s]+/[^/\s]+/[^/\s]+)/milestone/\d+$`)

type issueCount struct {
	TotalCount int `json:"totalCount"`
}

type forgeMilestone struct {
	Number int        `json:"number"`
	Title  string     `json:"title"`
	Url    string     `json:"url"`
	DueOn  string     `json:"dueOn"`
	Open   issueCount `json:"open"`
	Closed issueCount `json:"closed"`
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

// openTickets are the open issues of one milestone, newest update first, pull requests left out.
func openTickets(ctx context.Context, gh ghFunc, dir string, number int) ([]Ticket, error) {
	out, err := gh(ctx, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=open&sort=updated&direction=desc&per_page=%d", number, maxTickets))
	if err != nil {
		return nil, err
	}
	var issues []forgeIssue
	if err := json.Unmarshal(out, &issues); err != nil {
		return nil, errors.New("gh api issues: unreadable answer")
	}
	tickets := []Ticket{}
	for _, issue := range issues {
		if issue.Number <= 0 || (len(issue.PullRequest) > 0 && string(issue.PullRequest) != "null") {
			continue
		}
		title := cutRunes(oneLine(issue.Title), maxTitleRunes)
		excerpt := cleanExcerpt(issue.Body)
		tickets = append(tickets, Ticket{
			Number:  issue.Number,
			Title:   title,
			Url:     httpsOnly(issue.HtmlUrl),
			excerpt: excerpt,
			hash:    contentHash(title, excerpt),
		})
	}
	return tickets, nil
}

// readForge reads every open milestone, in the tabs' order, and the tickets of the first ticketMilestones of them and of
// those in selected. A milestone with no open issue has nothing to read: its tickets are all there is to know.
func readForge(ctx context.Context, gh ghFunc, dir string, selected []int) readResult {
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
	ordered := orderMilestones(list)
	if len(ordered) == 0 {
		return readResult{state: StateNone}
	}
	asked := make(map[int]bool, len(selected))
	for _, n := range selected {
		asked[n] = true
	}
	milestones := make([]Milestone, 0, len(ordered))
	repo := ""
	for i, fm := range ordered {
		if repo == "" {
			repo = repoOf(fm.Url)
		}
		m := Milestone{
			Number:    fm.Number,
			Title:     cutRunes(oneLine(fm.Title), maxTitleRunes),
			Url:       httpsOnly(fm.Url),
			Open:      max(0, fm.Open.TotalCount),
			Closed:    max(0, fm.Closed.TotalCount),
			Due:       unixMs(parseTime(fm.DueOn)),
			Remaining: max(0, fm.Open.TotalCount),
			Tickets:   []Ticket{},
			Loaded:    fm.Open.TotalCount <= 0,
		}
		if fm.Open.TotalCount > 0 && (i < ticketMilestones || asked[fm.Number]) {
			tickets, err := openTickets(ctx, gh, dir, fm.Number)
			if err != nil {
				return readResult{err: err}
			}
			m.Tickets, m.Loaded = tickets, true
			m.Remaining = max(m.Remaining, len(tickets))
		}
		milestones = append(milestones, m)
	}
	var numbers []int
	for _, m := range milestones {
		for _, t := range m.Tickets {
			numbers = append(numbers, t.Number)
		}
	}
	applyStatuses(milestones, readStatuses(ctx, gh, dir, numbers))
	return readResult{state: StateOk, repo: repo, milestones: milestones}
}
