// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"encoding/json"
	"strings"
)

// An agent in a worktree whose branch the host named (Claude Code's worktree-agent-<id>, pushed to the ticket branch
// with `git push origin HEAD:<branch>`) is on that PR all the same (#1955, FR-REV-022 AC21): its worktree's head commit
// is the PR's head. Tying it to the PR's head branch puts it on the PR's card and in the index the launchers read
// before they start an agent there, so a new agent never lands on top of it. Only the head commit counts: a worktree
// that is behind or ahead of the PR is not claimed.

// openPrHeadOids maps the open PRs' head commits to their head branches (none from a fork).
func openPrHeadOids(snap Snapshot) map[string]string {
	gh := snap.Github
	if gh == nil || gh.State != GithubStateOk || len(gh.Prs) == 0 {
		return nil
	}
	var prs []ghReviewPr
	if err := json.Unmarshal(gh.Prs, &prs); err != nil {
		return nil
	}
	rtn := map[string]string{}
	for _, pr := range prs {
		if !pr.IsCrossRepository && pr.HeadRefOid != "" {
			rtn[strings.ToLower(pr.HeadRefOid)] = pr.HeadRefName
		}
	}
	return rtn
}

// tieAgentsToPrs gives each agent working in a linked worktree on no open PR's branch the head branch of the open PR
// whose head commit the worktree is on. The main checkout is never tied: an agent there works on its own branch.
func tieAgentsToPrs(g *gitReader, agents []BranchAgent, snap Snapshot, mainPath string) []BranchAgent {
	oids := openPrHeadOids(snap)
	if len(oids) == 0 || len(agents) == 0 {
		return agents
	}
	heads := map[string]bool{}
	for _, branch := range oids {
		heads[branch] = true
	}
	headOf := map[string]string{}
	read := 0
	rtn := make([]BranchAgent, len(agents))
	copy(rtn, agents)
	for i, a := range rtn {
		if a.Worktree == "" || a.Worktree == mainPath || heads[a.Branch] {
			continue
		}
		oid, seen := headOf[a.Worktree]
		if !seen {
			if read >= backgroundMaxTrees {
				continue
			}
			read++
			out, err := (&gitReader{ctx: g.ctx, run: g.run, dir: a.Worktree}).out("rev-parse", "HEAD")
			if err == nil {
				oid = strings.ToLower(strings.TrimSpace(out))
			}
			headOf[a.Worktree] = oid
		}
		if branch, ok := oids[oid]; ok && oid != "" {
			rtn[i].Branch = branch
		}
	}
	return rtn
}
