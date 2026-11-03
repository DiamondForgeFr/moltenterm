// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// What a PR waits on before it can go on (#1841, FR-REV-022 AC10): a PR held until another one merges says so with a
// "Depends on #N" / "Waiting on #N" line in its body or in a comment of its author (the lead posts through the
// developer's gh), its ticket says so in its body ("Blocked by #N") or through GitHub's "blocked by" relationship.
// Each named number still open is listed on the PR (WaitsOn); once it merges or closes, the PR goes back to its
// normal state.

const (
	ReviewWaitFromBody     = "body"
	ReviewWaitFromComment  = "comment"
	ReviewWaitFromTicket   = "ticket"
	ReviewWaitFromRelation = "relation"

	ReviewWaitKindPr    = "pr"
	ReviewWaitKindIssue = "issue"

	ReviewWaitOpen = "open"

	// The numbers one PR may name, and GitHub's "blocked by" issues read per ticket.
	maxReviewWaits      = 5
	reviewBlockedByRead = 10
)

// A line naming what the PR waits on: the words, then the numbers on the rest of the line. A line holding the words
// alone (a "## Blocked by" heading) names the numbers of the list items that follow it.
var reviewWaitLineRe = regexp.MustCompile(`(?i)^(?:#{1,6}\s+|[-*+>]\s+)?(?:\*\*|__)?\s*(?:depends\s+on|dependent\s+on|waiting\s+(?:on|for)|blocked\s+by|held\s+(?:until|for|on|by)|on\s+hold\s+(?:until|for)|d[ée]pend\s+de|en\s+attente\s+de|bloqu[ée]+e?s?\s+par)\b[\s:*_]*(.*)$`)
var reviewWaitNumberRe = regexp.MustCompile(`(?:^|[^\w&/])#(\d{1,7})\b`)
var reviewWaitItemRe = regexp.MustCompile(`^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$`)

// ReviewDependency is a PR or an issue a PR waits on, still open.
type ReviewDependency struct {
	Number int    `json:"number"`
	Title  string `json:"title,omitempty"`
	Url    string `json:"url,omitempty"`
	Kind   string `json:"kind,omitempty"`
	State  string `json:"state"`
	// From: where the dependency is declared (ReviewWaitFromBody, …Comment, …Ticket, …Relation).
	From string `json:"from"`
}

type reviewDeclared struct {
	number int
	from   string
}

// DeclaredWaits reads the numbers a text says it waits on, in their order, each once.
func DeclaredWaits(text string) []int {
	var rtn []int
	seen := map[int]bool{}
	add := func(rest string) {
		for _, m := range reviewWaitNumberRe.FindAllStringSubmatch(rest, -1) {
			n, err := strconv.Atoi(m[1])
			if err != nil || n <= 0 || seen[n] {
				continue
			}
			seen[n] = true
			rtn = append(rtn, n)
		}
	}
	list := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if m := reviewWaitLineRe.FindStringSubmatch(line); m != nil {
			rest := strings.TrimSpace(m[1])
			add(rest)
			list = rest == "" || !reviewWaitNumberRe.MatchString(rest)
			continue
		}
		if !list {
			continue
		}
		if line == "" {
			continue
		}
		item := reviewWaitItemRe.FindStringSubmatch(line)
		if item == nil {
			list = false
			continue
		}
		add(item[1])
	}
	return rtn
}

// withDeclared adds a text's numbers to the PR's, its own number and its ticket's left out.
func withDeclared(list []reviewDeclared, pr ReviewPr, text string, from string) []reviewDeclared {
	for _, n := range DeclaredWaits(text) {
		if n == pr.Number || n == pr.Ticket || len(list) >= maxReviewWaits {
			continue
		}
		known := false
		for _, d := range list {
			if d.number == n {
				known = true
				break
			}
		}
		if !known {
			list = append(list, reviewDeclared{number: n, from: from})
		}
	}
	return list
}

type ghWaitItem struct {
	Typename string `json:"__typename"`
	Number   int    `json:"number"`
	Title    string `json:"title"`
	Url      string `json:"url"`
	State    string `json:"state"`
}

// reviewWaitsQuery reads, in one GraphQL query, the state of every number the PRs name, "" when they name none.
// Numbers are integers formatted here, never text from GitHub.
func reviewWaitsQuery(prs []ReviewPr, declared map[int][]reviewDeclared) string {
	numbers := map[int]bool{}
	for _, pr := range prs {
		for _, d := range declared[pr.Number] {
			numbers[d.number] = true
		}
	}
	if len(numbers) == 0 {
		return ""
	}
	sorted := make([]int, 0, len(numbers))
	for n := range numbers {
		sorted = append(sorted, n)
	}
	sort.Ints(sorted)
	var sb strings.Builder
	sb.WriteString("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){")
	for _, n := range sorted {
		fmt.Fprintf(&sb, "n%d:issueOrPullRequest(number:%d){__typename ...on Issue{number title url state} ...on PullRequest{number title url state}}", n, n)
	}
	sb.WriteString("}}")
	return sb.String()
}

func waitOf(item ghWaitItem, from string) ReviewDependency {
	kind := ReviewWaitKindIssue
	if item.Typename == "PullRequest" {
		kind = ReviewWaitKindPr
	}
	return ReviewDependency{Number: item.Number, Title: item.Title, Url: item.Url, Kind: kind, State: strings.ToLower(item.State), From: from}
}

// readReviewWaits keeps, for each PR, what it waits on that is still open: the numbers it names, whose state one more
// query reads (none when it names none), then the issues GitHub says block its ticket (blocked, read with the reports).
func readReviewWaits(ctx context.Context, run Runner, dir string, base []string, prs []ReviewPr, declared map[int][]reviewDeclared, blocked map[int][]ghWaitItem) (map[int][]ReviewDependency, error) {
	named, err := queryReviewWaits(ctx, run, dir, base, reviewWaitsQuery(prs, declared))
	if err != nil {
		return nil, err
	}
	rtn := map[int][]ReviewDependency{}
	for _, pr := range prs {
		var waits []ReviewDependency
		seen := map[int]bool{pr.Number: true, pr.Ticket: true}
		addOpen := func(w ReviewDependency) {
			if w.Number <= 0 || seen[w.Number] || w.State != ReviewWaitOpen {
				return
			}
			seen[w.Number] = true
			waits = append(waits, w)
		}
		for _, d := range declared[pr.Number] {
			if item := named[fmt.Sprintf("n%d", d.number)]; item != nil {
				addOpen(waitOf(*item, d.from))
			}
		}
		for _, item := range blocked[pr.Number] {
			addOpen(waitOf(item, ReviewWaitFromRelation))
		}
		if len(waits) > 0 {
			rtn[pr.Number] = waits
		}
	}
	return rtn, nil
}

func queryReviewWaits(ctx context.Context, run Runner, dir string, base []string, query string) (map[string]*ghWaitItem, error) {
	if query == "" {
		return map[string]*ghWaitItem{}, nil
	}
	args := append([]string{"api", "graphql", "-f", "query=" + query}, base...)
	out, err := run(ctx, dir, "gh", args...)
	var answer struct {
		Data struct {
			Repository map[string]*ghWaitItem `json:"repository"`
		} `json:"data"`
	}
	// A number that is neither an issue nor a PR comes back as an error beside the data: keep the data.
	if jsonErr := json.Unmarshal(out, &answer); jsonErr != nil || answer.Data.Repository == nil {
		if err != nil {
			return nil, fmt.Errorf("%s", shortGhError(err))
		}
		return nil, fmt.Errorf("gh api graphql: unreadable answer")
	}
	return answer.Data.Repository, nil
}
