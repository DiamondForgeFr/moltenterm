// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// What removing a worktree or a branch after the merge would lose (#672). The cleanup is complete by default: only real
// work keeps a worktree and its branch, that is uncommitted changes to tracked files, untracked files that are not
// ignored, and commits that are not in what GitHub merged. Git-ignored files (dependencies, build output, test results,
// a .env too) go with the folder: they are named, never a reason to keep it.

const (
	lossShown = 5
	// lossUnknown: git could not tell which commits are safe; read as "there may be work".
	lossUnknown = -1
)

type LossCommit struct {
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
}

// WorktreeLoss lists the first few of each and counts them all.
type WorktreeLoss struct {
	// Changes: uncommitted changes to tracked files and untracked files that are not ignored; lost with the folder.
	Changes     []string `json:"changes"`
	ChangeCount int      `json:"changecount"`
	// Commits whose work is not in the merged PR (nor on the base); lossUnknown when git could not tell.
	Commits     []LossCommit `json:"commits"`
	CommitCount int          `json:"commitcount"`
	// Ignored: the git-ignored files and folders removed with the folder, which a build or an install makes again.
	Ignored      []string `json:"ignored"`
	IgnoredCount int      `json:"ignoredcount"`
}

// Nothing: removing loses no work.
func (l WorktreeLoss) Nothing() bool {
	return l.ChangeCount == 0 && l.CommitCount == 0
}

func firstOf(items []string) []string {
	if len(items) > lossShown {
		return append([]string{}, items[:lossShown]...)
	}
	return append([]string{}, items...)
}

func worktreeLossOf(plan mission.WorktreePlan, commits []LossCommit, count int) WorktreeLoss {
	return WorktreeLoss{
		Changes:      firstOf(plan.Changes),
		ChangeCount:  plan.ChangeCount,
		Commits:      commits,
		CommitCount:  count,
		Ignored:      firstOf(plan.Ignored),
		IgnoredCount: plan.IgnoredCount,
	}
}

// mergedHead is the head GitHub merged, present in the local repository: every commit it reaches is safe whatever the
// merge method (rebase, squash or merge commit). "" when it cannot be had; refs/pull/<n>/head keeps it on GitHub after
// the branch is deleted.
func (r *cleanupRun) mergedHead() string {
	if r.mergedHeadRead {
		return r.mergedHeadOid
	}
	r.mergedHeadRead = true
	// A PR closed without merging (#1121): its head reached the base by nothing GitHub did.
	if r.req.Closed {
		return ""
	}
	oid := r.pr.HeadRefOid
	if !reviewsession.IsOid(oid) {
		return ""
	}
	has := func() bool {
		_, err := r.git(r.dir, "cat-file", "-e", oid+"^{commit}")
		return err == nil
	}
	if !has() {
		r.git(r.dir, "fetch", "--quiet", "origin", "refs/pull/"+strconv.Itoa(r.req.Number)+"/head")
		if !has() {
			return ""
		}
	}
	r.mergedHeadOid = oid
	return oid
}

func parseLossCommits(out string) []LossCommit {
	var rtn []LossCommit
	for _, line := range strings.Split(out, "\n") {
		sha, subject, ok := strings.Cut(line, "\x1f")
		if !ok || !reviewsession.IsOid(sha) {
			continue
		}
		rtn = append(rtn, LossCommit{Sha: sha, Subject: subject})
	}
	return rtn
}

func lossCommits(all []LossCommit) ([]LossCommit, int) {
	if len(all) > lossShown {
		return all[:lossShown], len(all)
	}
	if all == nil {
		all = []LossCommit{}
	}
	return all, len(all)
}

// commitsAtRisk lists ref's commits that are neither reachable from the merged head nor on the base. Without the merged
// head, a commit counts as safe when its patch is on the base (git cherry) or the branch's whole content is.
func (r *cleanupRun) commitsAtRisk(ref string) ([]LossCommit, int) {
	base := "refs/remotes/origin/" + r.pr.BaseRefName
	if head := r.mergedHead(); head != "" {
		out, err := r.git(r.dir, "log", "--format=%H%x1f%s", ref, "--not", head, base, "--")
		if err != nil {
			return []LossCommit{}, lossUnknown
		}
		return lossCommits(parseLossCommits(out))
	}
	// #1121: by content, so a copy of the work that reached the base with other commit ids (squash, conflicts resolved
	// differently) is safe, and anything git cannot judge is at risk.
	shas, ok := mission.CommitsNotOn(r.ctx, r.c.env.Run, r.dir, base, ref)
	if !ok {
		return []LossCommit{}, lossUnknown
	}
	if len(shas) == 0 {
		return []LossCommit{}, 0
	}
	out, err := r.git(r.dir, append([]string{"log", "--no-walk=unsorted", "--format=%H%x1f%s"}, shas...)...)
	if err != nil {
		return []LossCommit{}, lossUnknown
	}
	return lossCommits(parseLossCommits(out))
}
