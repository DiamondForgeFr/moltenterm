// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// The board Status of the tickets a companion shows (#2418): a ticket In progress or later is taken even when no agent
// MoltenTerm knows works on it, so the Tasks block does not offer it to every other agent. The REST issues of the
// milestone do not carry the project board; one GraphQL call reads it for all of them, with the same query the
// Integration panel uses for its branches' tickets (pkg/molten/mission/upcoming.go). A token without the project scope,
// a repository on no board or any failure leaves the statuses empty: the block then knows only what it knew before.

const (
	// The tickets whose status is read in one call, in the order of the tabs.
	maxStatusTickets = 300
	// A ticket in several projects: the first status found among its first items.
	statusItems = 5
)

// statusNameRegex keeps a status name to plain words: it is shown in the window and compared with what the board calls
// its columns, never interpreted.
var statusNameRegex = regexp.MustCompile(`^[\p{L}\p{N} _-]{1,40}$`)

func statusQuery(numbers []int) string {
	var sb strings.Builder
	sb.WriteString("query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {")
	for _, n := range numbers {
		fmt.Fprintf(&sb, " t%d: issue(number: %d) { projectItems(first: %d) { nodes { status: fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }", n, n, statusItems)
	}
	sb.WriteString(" } }")
	return sb.String()
}

type statusItem struct {
	Status *struct {
		Name string `json:"name"`
	} `json:"status"`
}

type statusIssue struct {
	ProjectItems struct {
		Nodes []statusItem `json:"nodes"`
	} `json:"projectItems"`
}

type statusAnswer struct {
	Data struct {
		Repository map[string]*statusIssue `json:"repository"`
	} `json:"data"`
}

// parseStatuses reads the answer of statusQuery: each ticket's first status that is a plain name.
func parseStatuses(out []byte, numbers []int) map[int]string {
	var answer statusAnswer
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil
	}
	rtn := map[int]string{}
	for _, n := range numbers {
		issue := answer.Data.Repository[fmt.Sprintf("t%d", n)]
		if issue == nil {
			continue
		}
		for _, item := range issue.ProjectItems.Nodes {
			if item.Status != nil && statusNameRegex.MatchString(item.Status.Name) {
				rtn[n] = item.Status.Name
				break
			}
		}
	}
	return rtn
}

// readStatuses is the board status of the tickets, by number; empty when it cannot be read.
func readStatuses(ctx context.Context, gh ghFunc, dir string, numbers []int) map[int]string {
	if len(numbers) == 0 {
		return nil
	}
	if len(numbers) > maxStatusTickets {
		numbers = numbers[:maxStatusTickets]
	}
	out, err := gh(ctx, dir, "api", "graphql", "-f", "query="+statusQuery(numbers), "-F", "owner={owner}", "-F", "name={repo}")
	if err != nil {
		return nil
	}
	return parseStatuses(out, numbers)
}

// applyStatuses gives each ticket its board status.
func applyStatuses(milestones []Milestone, statuses map[int]string) {
	if len(statuses) == 0 {
		return
	}
	for i := range milestones {
		for j := range milestones[i].Tickets {
			milestones[i].Tickets[j].Status = statuses[milestones[i].Tickets[j].Number]
		}
	}
}
