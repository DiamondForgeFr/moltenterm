// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"regexp"
)

// One card per ticket (#1172, FR-REV-022 AC11): a ticket branch whose ticket already has an open PR from another
// branch (a local test copy such as test/1163-local, an agent worktree's own branch) is never Upcoming. It is listed
// on that PR's card instead, as one more branch of the same ticket.

// UpcomingPrBranch is another branch of an open PR's ticket, with commits ahead of the PR target.
type UpcomingPrBranch struct {
	Branch string `json:"branch"`
	Ticket int    `json:"ticket"`
	// The open PR of the same ticket, whose card lists the branch.
	Pr       int    `json:"pr"`
	Ahead    int    `json:"ahead"`
	Remote   bool   `json:"remote,omitempty"`
	Worktree string `json:"worktree,omitempty"`
}

// openPrTickets: by ticket, the open PR of the repository that carries it (its closing issue, else its head branch's
// ticket), the lowest PR number when several do. Cross-repository PRs are not the project's branches.
func openPrTickets(snap Snapshot, ticketRes []*regexp.Regexp) map[int]int {
	gh := snap.Github
	rtn := map[int]int{}
	if gh == nil || gh.State != GithubStateOk || gh.Errors["prs"] != "" || len(gh.Prs) == 0 {
		return rtn
	}
	var prs []ghReviewPr
	if err := json.Unmarshal(gh.Prs, &prs); err != nil {
		return rtn
	}
	for _, pr := range prs {
		if pr.IsCrossRepository {
			continue
		}
		ticket := ticketOfBranch(pr.HeadRefName, ticketRes)
		if len(pr.ClosingIssuesReferences) > 0 && pr.ClosingIssuesReferences[0].Number > 0 {
			ticket = pr.ClosingIssuesReferences[0].Number
		}
		if ticket <= 0 {
			continue
		}
		if have, ok := rtn[ticket]; !ok || pr.Number < have {
			rtn[ticket] = pr.Number
		}
	}
	return rtn
}

// prBranchOf: the candidate as a branch of its ticket's open PR; false when its ticket has no open PR.
func prBranchOf(c UpcomingBranch, prTickets map[int]int) (UpcomingPrBranch, bool) {
	pr, ok := prTickets[c.Ticket]
	if !ok || c.Ticket <= 0 {
		return UpcomingPrBranch{}, false
	}
	return UpcomingPrBranch{Branch: c.Branch, Ticket: c.Ticket, Pr: pr, Ahead: c.Ahead, Remote: c.Remote, Worktree: c.Worktree}, true
}
