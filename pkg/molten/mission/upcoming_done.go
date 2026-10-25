// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"strconv"
	"strings"
)

// A ticket branch whose PR is done (#1088, FR-REV-022 AC14). The collector's read of the recently closed PRs (merged or
// not, with their head commit) tells the upcoming work which candidate branches already had their PR: a branch whose
// tip is the merged PR's head, or one of its commits, holds nothing new and is a leftover to clean up (worktree, agent
// session, branches), never Upcoming. A branch with commits after that head is follow-up work and stays, saying so; a
// PR closed without merging leaves its branch Upcoming with its own wording. The commits are compared by sha: a squash
// or rebase merge never puts the branch's commits on the target, so "ahead of the target" cannot tell.

const (
	UpcomingAfterMerged = "merged"
	UpcomingAfterClosed = "closed"

	ghPrStateMerged = "MERGED"
)

// UpcomingLeftover is what a merged PR left: its branch (local, on origin or both) and the linked worktree on it.
type UpcomingLeftover struct {
	Branch string `json:"branch"`
	Ticket int    `json:"ticket,omitempty"`
	Pr     int    `json:"pr"`
	Title  string `json:"title,omitempty"`
	Url    string `json:"url,omitempty"`
	// When GitHub merged it, as gh gives it (RFC 3339).
	MergedAt string `json:"mergedat,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	// Local: the branch exists here; Remote: origin still has it.
	Local  bool `json:"local,omitempty"`
	Remote bool `json:"remote,omitempty"`
	// The branch's last commit, in Unix milliseconds.
	CommitAt int64 `json:"commitat,omitempty"`
}

type ghClosedPr struct {
	Number            int    `json:"number"`
	Title             string `json:"title"`
	Url               string `json:"url"`
	State             string `json:"state"`
	HeadRefName       string `json:"headRefName"`
	HeadRefOid        string `json:"headRefOid"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	MergedAt          string `json:"mergedAt"`
	ClosedAt          string `json:"closedAt"`
}

func (pr ghClosedPr) merged() bool {
	return pr.MergedAt != "" || pr.State == ghPrStateMerged
}

func (pr ghClosedPr) endedAt() string {
	if pr.MergedAt != "" {
		return pr.MergedAt
	}
	return pr.ClosedAt
}

// closedPrsByBranch: the newest closed PR (merged or not) of each head branch of the repository, from the collector's
// snapshot; nil when GitHub was not read.
func closedPrsByBranch(snap Snapshot) map[string]ghClosedPr {
	gh := snap.Github
	if gh == nil || gh.State != GithubStateOk || gh.Errors["merged"] != "" || len(gh.Merged) == 0 {
		return nil
	}
	var prs []ghClosedPr
	if err := json.Unmarshal(gh.Merged, &prs); err != nil {
		return nil
	}
	rtn := map[string]ghClosedPr{}
	for _, pr := range prs {
		if pr.IsCrossRepository || pr.HeadRefName == "" {
			continue
		}
		// RFC 3339 times in UTC compare as text.
		if have, ok := rtn[pr.HeadRefName]; ok && have.endedAt() >= pr.endedAt() {
			continue
		}
		rtn[pr.HeadRefName] = pr
	}
	return rtn
}

// afterHead counts the branch's commits after the PR's head: 0 when its tip is that head or one of its commits, -1
// when git cannot tell (the head was never fetched here). ok false: the head is unknown to git.
func afterHead(g *gitReader, ref string, head string) (int, bool) {
	if !commitOidRe.MatchString(head) {
		return -1, false
	}
	if _, err := g.out("cat-file", "-e", head+"^{commit}"); err != nil {
		return -1, false
	}
	if _, err := g.out("merge-base", "--is-ancestor", ref, head); err == nil {
		return 0, true
	}
	out, err := g.out("rev-list", "--count", head+".."+ref)
	if err != nil {
		return -1, true
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return -1, true
	}
	return n, true
}

// donePr is a candidate branch's closed PR as the upcoming work reads it: leftover, or the after-PR facts the branch
// keeps in Upcoming. found false: the branch had no PR closed in the window.
type donePr struct {
	found    bool
	leftover bool
	pr       ghClosedPr
	after    int
}

// classifyDone reads what the branch holds after its closed PR. A merged head git does not know (pushed from another
// clone) is compared by content: the branch is a leftover when all its code is on the target.
func classifyDone(g *gitReader, closed map[string]ghClosedPr, c UpcomingBranch, ref string, targetRef string) donePr {
	pr, ok := closed[c.Branch]
	if !ok {
		return donePr{}
	}
	after, known := afterHead(g, ref, pr.HeadRefOid)
	if !known && pr.merged() {
		if on := BranchContentOn(g.ctx, g.run, g.dir, targetRef, ref); on != nil && *on {
			after = 0
		}
	}
	return donePr{found: true, leftover: pr.merged() && after == 0, pr: pr, after: after}
}

// LeftoverOf is the leftover card of a merged PR's branch.
func LeftoverOf(c UpcomingBranch, pr ghClosedPr, remotes map[string]bool) UpcomingLeftover {
	return UpcomingLeftover{
		Branch: c.Branch, Ticket: c.Ticket, Pr: pr.Number, Title: pr.Title, Url: pr.Url, MergedAt: pr.MergedAt,
		Worktree: c.Worktree, Local: !c.Remote, Remote: c.Remote || remotes[c.Branch], CommitAt: c.CommitAt,
	}
}

// withAfter puts a closed PR's facts on a branch that stays Upcoming.
func withAfter(c UpcomingBranch, done donePr) UpcomingBranch {
	if !done.found {
		return c
	}
	c.AfterPr, c.AfterCount = done.pr.Number, done.after
	c.AfterState = UpcomingAfterClosed
	if done.pr.merged() {
		c.AfterState = UpcomingAfterMerged
	}
	return c
}

func remoteBranches(refs []branchRef) map[string]bool {
	rtn := map[string]bool{}
	for _, ref := range refs {
		if ref.remote {
			rtn[ref.name] = true
		}
	}
	return rtn
}
