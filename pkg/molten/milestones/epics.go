// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Epics are no work (FR-SHELL-018, #2454): an epic is a container that sits In progress while its stories run, so it is
// left out of a milestone's tickets and of its counts. GitHub marks one by its issue type (sf-epic in a SaaSFoundry
// project, Epic elsewhere). The milestone's own counts include them, so the repository's issue types are read, then the
// open and closed epics of each milestone are counted in one call, each by a filter on its type. A repository without
// issue types, or any failure, leaves the counts as the forge gave them, less the open epics seen among the tickets read.

const (
	maxIssueTypes = 25
	// The epic types counted at most: a repository names one, rarely two.
	maxEpicTypes = 3
)

const issueTypesQuery = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issueTypes(first: 25) { nodes { name } } } }`

// isEpicType: the issue type of a container: "Epic", or a prefixed one ("sf-epic", "team_epic", "Team epic").
func isEpicType(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "epic" {
		return true
	}
	for _, sep := range []string{"-", "_", " "} {
		if strings.HasSuffix(n, sep+"epic") {
			return true
		}
	}
	return false
}

type issueTypesAnswer struct {
	Data struct {
		Repository *struct {
			IssueTypes *struct {
				Nodes []struct {
					Name string `json:"name"`
				} `json:"nodes"`
			} `json:"issueTypes"`
		} `json:"repository"`
	} `json:"data"`
}

// epicTypes are the repository's epic issue types; ok is false when they cannot be read.
func epicTypes(ctx context.Context, gh ghFunc, dir string) ([]string, bool) {
	out, err := gh(ctx, dir, "api", "graphql", "-f", "query="+issueTypesQuery, "-F", "owner={owner}", "-F", "name={repo}")
	if err != nil {
		return nil, false
	}
	var answer issueTypesAnswer
	if json.Unmarshal(out, &answer) != nil || answer.Data.Repository == nil {
		return nil, false
	}
	if answer.Data.Repository.IssueTypes == nil {
		return nil, true
	}
	var types []string
	for _, node := range answer.Data.Repository.IssueTypes.Nodes {
		if isEpicType(node.Name) && statusNameRegex.MatchString(node.Name) && len(types) < maxEpicTypes {
			types = append(types, node.Name)
		}
	}
	return types, true
}

type epicCount struct {
	open   int
	closed int
}

// epicCountsQuery counts each milestone's open and closed issues of each epic type; the type names go as variables,
// never into the query's text.
func epicCountsQuery(numbers []int, types []string) string {
	var sb strings.Builder
	sb.WriteString("query($owner: String!, $name: String!")
	for i := range types {
		fmt.Fprintf(&sb, ", $e%d: String!", i)
	}
	sb.WriteString(") { repository(owner: $owner, name: $name) {")
	for _, n := range numbers {
		fmt.Fprintf(&sb, " m%d: milestone(number: %d) {", n, n)
		for i := range types {
			fmt.Fprintf(&sb, " o%d: issues(states: OPEN, filterBy: {type: $e%d}) { totalCount } c%d: issues(states: CLOSED, filterBy: {type: $e%d}) { totalCount }", i, i, i, i)
		}
		sb.WriteString(" }")
	}
	sb.WriteString(" } }")
	return sb.String()
}

type epicCountsAnswer struct {
	Data struct {
		Repository map[string]map[string]issueCount `json:"repository"`
	} `json:"data"`
}

func parseEpicCounts(out []byte, numbers []int, types []string) (map[int]epicCount, bool) {
	var answer epicCountsAnswer
	if json.Unmarshal(out, &answer) != nil || answer.Data.Repository == nil {
		return nil, false
	}
	rtn := map[int]epicCount{}
	for _, n := range numbers {
		counts, ok := answer.Data.Repository[fmt.Sprintf("m%d", n)]
		if !ok || counts == nil {
			return nil, false
		}
		var c epicCount
		for i := range types {
			c.open += max(0, counts[fmt.Sprintf("o%d", i)].TotalCount)
			c.closed += max(0, counts[fmt.Sprintf("c%d", i)].TotalCount)
		}
		rtn[n] = c
	}
	return rtn, true
}

// readEpicCounts is the number of open and closed epics of each milestone, by number. ok is false when the repository
// has epic types that could not be counted: the caller then knows only the epics among the tickets it read.
func readEpicCounts(ctx context.Context, gh ghFunc, dir string, list []forgeMilestone) (map[int]epicCount, bool) {
	var numbers []int
	for _, fm := range list {
		if fm.Number > 0 && fm.Open.TotalCount+fm.Closed.TotalCount > 0 {
			numbers = append(numbers, fm.Number)
		}
	}
	if len(numbers) == 0 {
		return map[int]epicCount{}, true
	}
	types, ok := epicTypes(ctx, gh, dir)
	if !ok {
		return nil, false
	}
	if len(types) == 0 {
		return map[int]epicCount{}, true
	}
	args := []string{"api", "graphql", "-f", "query=" + epicCountsQuery(numbers, types), "-F", "owner={owner}", "-F", "name={repo}"}
	for i, name := range types {
		args = append(args, "-f", fmt.Sprintf("e%d=%s", i, name))
	}
	out, err := gh(ctx, dir, args...)
	if err != nil {
		return nil, false
	}
	return parseEpicCounts(out, numbers, types)
}
