// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"
)

// The English text of Validate's plan, merge and cleanup for `molten review` (#672): wavesrv gives codes and data, the
// Validate sheet writes them in the interface's language, and the CLI in English (agents parse it).
// must match the codes of pkg/molten/review (merge.go, cleanup.go, loss.go)

var moltenReviewCheckLabels = map[string]string{
	"open":     "Open and ready for review",
	"ci":       "CI is green, local-* statuses included",
	"conflict": "No conflict with the base",
	"blocked":  "Not blocked by the repository's rules",
	"behind":   "Up to date with the base",
	"comments": "No unpublished comment",
	"restart":  "No restart of the work in flight",
}

func moltenReviewNames(names []string) string {
	const shown = 3
	if len(names) <= shown {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:shown], ", ") + fmt.Sprintf(" and %d more", len(names)-shown)
}

func moltenReviewCheckLabel(c moltenReviewCheck) string {
	if label := moltenReviewCheckLabels[c.Id]; label != "" {
		return label
	}
	return c.Id
}

func moltenReviewCheckDetail(c moltenReviewCheck) string {
	switch c.Code {
	case "notopen":
		return "the pull request is " + c.PrState
	case "draft":
		return "the pull request is a draft"
	case "failing":
		return fmt.Sprintf("%d failing: %s", c.Count, moltenReviewNames(c.Names))
	case "running":
		return fmt.Sprintf("%d still running: %s", c.Count, moltenReviewNames(c.Names))
	case "nocheck":
		return "no check reported"
	case "passed":
		if c.Local > 0 {
			return fmt.Sprintf("%d passed, %d of them local", c.Count, c.Local)
		}
		return fmt.Sprintf("%d passed", c.Count)
	case "conflicting":
		return "conflicts with " + c.Base + ": it needs a rebase"
	case "computing":
		return "GitHub is still computing whether it merges cleanly"
	case "blocked":
		return "a required check or review is missing"
	case "behind":
		return "behind " + c.Base + ": GitHub rebases it first, then the merge waits for CI"
	case "unpublished":
		return fmt.Sprintf("%d comment(s) not published", c.Count)
	case "inflight":
		return "an agent may still be working on this head"
	}
	return ""
}

func moltenReviewStepText(id string, plan moltenReviewPlan) string {
	switch id {
	case "update":
		return fmt.Sprintf("GitHub rebases %s on %s", plan.HeadRef, plan.BaseRef)
	case "waitci":
		return "Wait for CI on the rebased head"
	case "merge":
		return fmt.Sprintf("Rebase and merge into %s, then delete %s on GitHub (bound to head %s)", plan.BaseRef, plan.HeadRef, moltenReviewShort(plan.HeadOid))
	}
	return id
}

func moltenReviewMergeText(m moltenReviewMerge) string {
	text := ""
	switch m.Code {
	case "merged":
		text = "rebased and merged at " + moltenReviewShort(m.Head)
	case "reread":
		text = "the pull request could not be read again before the merge"
	case "mergedaway":
		text = "the pull request was merged outside MoltenTerm"
	case "headmoved":
		text = fmt.Sprintf("new commits were pushed (head %s, expected %s): review them, then Validate again", moltenReviewShort(m.MovedTo), moltenReviewShort(m.MovedFrom))
	case "githubheadmoved":
		text = "GitHub refused the merge because the branch moved: review the new commits, then Validate again"
	case "check":
		text = "not merged, a check fails now"
		if m.Blocking != nil {
			text += ": " + moltenReviewCheckLabel(*m.Blocking)
			if d := moltenReviewCheckDetail(*m.Blocking); d != "" {
				text += " (" + d + ")"
			}
		}
	case "newwarning":
		text = "not merged: a new warning appeared since the plan, Validate again"
	case "mergeerror":
		text = "the merge failed and is not retried"
	case "updateerror":
		text = "GitHub could not rebase the branch on its base"
	case "stopped":
		text = "stopped while waiting for CI: nothing was merged"
	case "citimeout":
		text = fmt.Sprintf("CI did not finish on the rebased head within %d minutes: nothing was merged", m.Minutes)
	case "pollerror":
		text = "the pull request could not be read while waiting for CI"
	case "cifailed":
		text = "CI failed on the rebased head (" + moltenReviewNames(m.Names) + "): nothing was merged"
	case "conflict":
		text = "the rebased branch conflicts with its base: nothing was merged"
	case "basemoved":
		text = "the base moved again while CI ran: nothing was merged, Validate again"
	case "rebasedblocked":
		text = "GitHub blocks the merge of the rebased head: a required check or review is missing"
	}
	if m.Error != "" {
		if text != "" {
			text += ": "
		}
		text += m.Error
	}
	return text
}

func moltenReviewLossText(l *moltenReviewLoss) string {
	if l == nil {
		return ""
	}
	var parts []string
	if l.ChangeCount > 0 {
		parts = append(parts, fmt.Sprintf("%d uncommitted file(s): %s", l.ChangeCount, moltenReviewNames(l.Changes)))
	}
	if l.CommitCount > 0 {
		var subjects []string
		for _, c := range l.Commits {
			subjects = append(subjects, moltenReviewShort(c.Sha)+" "+c.Subject)
		}
		parts = append(parts, fmt.Sprintf("%d commit(s) not in the merged PR: %s", l.CommitCount, moltenReviewNames(subjects)))
	}
	if l.CommitCount < 0 {
		parts = append(parts, "commits git could not check")
	}
	return strings.Join(parts, "; ")
}

func moltenReviewCleanupDetail(s moltenReviewCleanupStep) string {
	text := ""
	switch s.Code {
	case "merged":
		text = "merged into " + s.Base
	case "notmerged":
		text = "the PR is not merged"
	case "prunconfirmed":
		text = "the merged PR could not be confirmed"
	case "noticket":
		text = "no ticket found for the PR"
	case "closed", "moveddone":
		text = fmt.Sprintf("#%d", s.Ticket)
	case "alreadyclosed":
		text = fmt.Sprintf("#%d is already closed", s.Ticket)
	case "alreadydone":
		text = fmt.Sprintf("#%d is already Done", s.Ticket)
	case "nosfworkflow":
		text = "the project does not use sf-workflow"
	case "noreviewtree":
		text = "no review worktree of this PR"
	case "notaworktree":
		text = s.Path + " is not a worktree of the project"
	case "noagenttree":
		text = "no worktree has " + s.Branch + " checked out"
	case "refusedhome", "refusedrepo":
		text = "MoltenTerm does not remove " + s.Path
	case "locked":
		text = "the worktree is locked"
	case "kept":
		text = "kept, removing it would lose " + moltenReviewLossText(s.Loss)
	case "alreadygone":
		text = "already removed"
	case "removed":
		text = s.Path
	case "willremove":
		text = s.Path + " will be removed unless it holds work of its own"
	case "nolocalbranch":
		text = "no local branch " + s.Branch
	case "treefailed":
		text = "depends on the agent worktree, which could not be removed"
	case "inkepttree":
		text = s.Branch + " is checked out in the kept agent worktree"
	case "inmaincheckout":
		text = s.Branch + " is checked out in the project's main checkout"
	case "moved":
		text = s.Branch + " moved since you confirmed: kept"
	case "deleted":
		text = s.Branch
	case "deletedbymerge":
		text = "origin/" + s.Branch + " was deleted by the merge"
	case "pushedafter":
		text = "origin/" + s.Branch + " has commits pushed after the merge: kept"
	case "noother":
		text = "no other open PR on " + s.Base
	case "otherprs":
		text = fmt.Sprintf("%d updated, %d flagged, %d failed", s.Updated, s.Flagged, s.Failed)
	}
	if s.Error != "" {
		if text != "" {
			text += ": "
		}
		text += s.Error
	}
	return text
}
