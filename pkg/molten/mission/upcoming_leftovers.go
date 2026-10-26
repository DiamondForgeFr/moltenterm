// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What else a done PR leaves (#1121, FR-REV-022 AC15): a worktree whose lock's holder ended, local copies of the PR's
// branch, and MoltenTerm's review worktree of a PR merged outside Validate. Each is listed only when removing it loses
// nothing: a copy's tip is the merged head or one of its commits (else its content is on the target), and the cleanup
// checks the worktrees again (FR-REV-013). A worktree locked by a process still running is never removed by MoltenTerm:
// its leftover is listed with that owner (#1143, leftover_owner.go), whom Clean up asks to check and remove it.

// localBranchFormat: name, tip, upstream and whether the upstream is gone, NUL-separated.
const localBranchFormat = "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)"

var prCopyRe = regexp.MustCompile(`^pr-?([1-9]\d{0,8})$`)

type localBranch struct {
	name     string
	tip      string
	upstream string
	gone     bool
}

func parseLocalBranches(lines []string) []localBranch {
	var rtn []localBranch
	for _, line := range lines {
		parts := strings.Split(line, "\x00")
		if len(parts) != 4 {
			continue
		}
		name, ok := strings.CutPrefix(parts[0], "refs/heads/")
		if !ok || name == "" {
			continue
		}
		rtn = append(rtn, localBranch{name: name, tip: parts[1], upstream: parts[2], gone: strings.Contains(parts[3], "gone")})
	}
	return rtn
}

// ExtraLeftoverFacts is what ExtraLeftovers reads besides git: the worktrees, the local branches, the branches already
// Upcoming (never a copy), the target, and the folder of the project's review worktrees ("" when unknown).
type ExtraLeftoverFacts struct {
	Trees       []treeEntry
	Locals      []localBranch
	Upcoming    map[string]bool
	Target      string
	TargetRef   string
	ReviewTrees string
}

func upcomingNames(candidates []UpcomingBranch) map[string]bool {
	rtn := map[string]bool{}
	for _, c := range candidates {
		rtn[c.Branch] = true
	}
	return rtn
}

// withTreeLock says how the leftover's worktree is locked. A running process holding it is the leftover's owner
// (#1143), named by ownerOf; nil ownerOf: the leftover is not shown, as before #1143.
func withTreeLock(l UpcomingLeftover, trees []treeEntry, ownerOf func(holder LockHolder, worktree string) LeftoverOwner) (UpcomingLeftover, bool) {
	if l.Worktree == "" {
		return l, true
	}
	for _, tree := range trees {
		if tree.path != l.Worktree || !tree.locked {
			continue
		}
		ended, pid := LockEnded(tree.lockReason)
		switch {
		case ended:
			l.Lock, l.LockPid = LeftoverLockEnded, pid
		case pid > 0:
			holder, _ := ParseLockReason(tree.lockReason)
			if ownerOf == nil {
				return l, false
			}
			owner := ownerOf(holder, l.Worktree)
			l.Lock, l.LockPid, l.Owner = LeftoverLockLive, pid, &owner
		default:
			l.Lock = LeftoverLockHeld
		}
	}
	return l, true
}

// copyPr is the merged PR a local branch copies: pr<N> of a merged PR N, or a branch whose upstream was that PR's head
// branch and is gone, or a branch named like a merged PR's head that no ticket naming made a candidate.
func copyPr(b localBranch, closed map[string]ghClosedPr, byNumber map[int]ghClosedPr) (ghClosedPr, bool) {
	if m := prCopyRe.FindStringSubmatch(b.name); m != nil {
		n, _ := strconv.Atoi(m[1])
		if pr, ok := byNumber[n]; ok && pr.merged() {
			return pr, true
		}
	}
	if head, ok := strings.CutPrefix(b.upstream, "refs/remotes/origin/"); ok && b.gone {
		if pr, ok := closed[head]; ok && pr.merged() {
			return pr, true
		}
	}
	if pr, ok := closed[b.name]; ok && pr.merged() {
		return pr, true
	}
	return ghClosedPr{}, false
}

// copyHoldsNothing: the copy's tip is the merged head or one of its commits, else all its content is on the target.
func copyHoldsNothing(g *gitReader, b localBranch, pr ghClosedPr, targetRef string) bool {
	ref := "refs/heads/" + b.name
	if after, known := afterHead(g, ref, pr.HeadRefOid); known {
		return after == 0
	}
	notOn, ok := CommitsNotOn(g.ctx, g.run, g.dir, targetRef, ref)
	return ok && len(notOn) == 0
}

// ExtraLeftovers adds the merged PRs' local copies and review worktrees to the leftovers, on the PR's card or on one
// made for them when the PR's branch itself is gone.
func ExtraLeftovers(g *gitReader, closed map[string]ghClosedPr, leftovers []UpcomingLeftover, facts ExtraLeftoverFacts) []UpcomingLeftover {
	if len(closed) == 0 {
		return leftovers
	}
	byNumber := map[int]ghClosedPr{}
	for _, pr := range closed {
		byNumber[pr.Number] = pr
	}
	index := map[int]int{}
	for i, l := range leftovers {
		index[l.Pr] = i
	}
	cardOf := func(pr ghClosedPr) *UpcomingLeftover {
		if i, ok := index[pr.Number]; ok {
			return &leftovers[i]
		}
		leftovers = append(leftovers, UpcomingLeftover{
			Branch: pr.HeadRefName, Pr: pr.Number, Title: pr.Title, Url: pr.Url, MergedAt: pr.MergedAt,
			State: UpcomingAfterMerged, Base: facts.Target,
		})
		index[pr.Number] = len(leftovers) - 1
		return &leftovers[len(leftovers)-1]
	}
	checkedOut := map[string]bool{}
	for _, tree := range facts.Trees {
		if tree.branch != "" {
			checkedOut[tree.branch] = true
		}
	}
	listed := map[string]bool{}
	for _, l := range leftovers {
		listed[l.Branch] = true
	}
	for _, b := range facts.Locals {
		if b.name == facts.Target || checkedOut[b.name] || listed[b.name] || facts.Upcoming[b.name] {
			continue
		}
		pr, ok := copyPr(b, closed, byNumber)
		if !ok || !copyHoldsNothing(g, b, pr, facts.TargetRef) {
			continue
		}
		card := cardOf(pr)
		if b.name == pr.HeadRefName {
			// The PR's own branch, beyond the candidates read (or not named like a ticket): the cleanup's local branch.
			card.Local = true
			continue
		}
		card.Copies = append(card.Copies, b.name)
	}
	if facts.ReviewTrees != "" {
		for i, tree := range facts.Trees {
			if i == 0 || !tree.detached || tree.locked || filepath.Dir(tree.path) != facts.ReviewTrees {
				continue
			}
			pr, ok := byNumber[molten.ReviewTreeNumber(filepath.Base(tree.path))]
			if !ok {
				continue
			}
			if _, has := index[pr.Number]; !has && !pr.merged() {
				continue
			}
			cardOf(pr).ReviewTree = tree.path
		}
	}
	for i := range leftovers {
		sort.Strings(leftovers[i].Copies)
	}
	return leftovers
}
