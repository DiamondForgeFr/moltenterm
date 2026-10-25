// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import "strings"

// The PR's local copies (#1121, FR-REV-013 AC9): branches like pr164 that a review checkout made of the PR's head.
// Each named one goes when it is checked out nowhere and holds no commit outside the merged head or the base; the
// others stay, named.

func (r *cleanupRun) checkedOutBranches() (map[string]bool, error) {
	entries, err := r.worktreeEntries()
	if err != nil {
		return nil, err
	}
	rtn := map[string]bool{}
	for _, e := range entries {
		if name, ok := strings.CutPrefix(e[1], "refs/heads/"); ok {
			rtn[name] = true
		}
	}
	return rtn, nil
}

func (r *cleanupRun) deleteCopies() CleanupStepResult {
	checkedOut, err := r.checkedOutBranches()
	if err != nil {
		return failed(CleanupStepCopyBranches, err)
	}
	var deleted, kept []string
	for _, name := range r.req.Copies {
		if name == r.pr.BaseRefName || name == r.pr.HeadRefName {
			kept = append(kept, name)
			continue
		}
		ref := "refs/heads/" + name
		if tip, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", ref); err != nil || tip == "" {
			continue
		}
		if checkedOut[name] {
			kept = append(kept, name)
			continue
		}
		if _, count := r.commitsAtRisk(ref); count != 0 {
			kept = append(kept, name)
			continue
		}
		if _, err := r.git(r.dir, "branch", "-D", name); err != nil {
			return failed(CleanupStepCopyBranches, err)
		}
		deleted = append(deleted, name)
	}
	step := done(CleanupStepCopyBranches, CleanupCodeDeleted)
	if len(kept) > 0 {
		step = skipped(CleanupStepCopyBranches, CleanupCodeCopiesKept)
		step.Names, step.NameCount = kept, len(kept)
	}
	step.Base, step.Count = r.pr.BaseRefName, len(deleted)
	return step
}
