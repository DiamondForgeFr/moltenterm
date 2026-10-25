// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

// #1132: Validate's merge leaves origin's branch to the cleanup, which deletes it last, once the worktree and the local
// branch are gone. A batch merge (FR-REV-025) merges through Validate, with its queued PRs in BatchPrs.

// keepRemoteBranch puts the PR's branch back on origin at the merged head: a merge that did not delete it.
func (f *cleanupFixture) keepRemoteBranch() {
	f.t.Helper()
	f.git(f.agent, "push", "--quiet", "origin", "feature/7-thing")
}

func (f *cleanupFixture) remoteHasBranch() bool {
	f.t.Helper()
	return f.git(f.dir, "ls-remote", "--heads", "origin", "feature/7-thing") != ""
}

// gitIndex is the index of the first git call holding part, -1 when none.
func (f *cleanupFixture) gitIndex(part string) int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return slices.IndexFunc(f.gitCalls, func(call string) bool { return strings.Contains(call, part) })
}

var cleanupOrderRequests = map[string]CleanupRequest{
	"validate": {},
	"batch":    {BatchPrs: []int{8, 9}},
}

func TestCleanupDeletesOriginBranchLast(t *testing.T) {
	for name, req := range cleanupOrderRequests {
		t.Run(name, func(t *testing.T) {
			f := makeCleanupFixture(t, true)
			f.keepRemoteBranch()

			result := f.cleanup(req)

			expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
			expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
			if step := expectStep(t, result, CleanupStepRemoteBranch, CleanupStateDone); step.Code != CleanupCodeDeleted {
				t.Errorf("remote branch: %+v", step)
			}
			if f.remoteHasBranch() {
				t.Errorf("origin's branch is still there")
			}
			tree, local, remote := f.gitIndex("worktree remove"), f.gitIndex("branch -D feature/7-thing"), f.gitIndex("push --quiet origin --delete feature/7-thing")
			if tree < 0 || local <= tree || remote <= local {
				t.Errorf("order: worktree %d, local branch %d, origin %d\n%s", tree, local, remote, strings.Join(f.gitCalls, "\n"))
			}
		})
	}
}

func TestCleanupKeepsOriginBranchWhenTheWorktreeRemovalFails(t *testing.T) {
	for name, req := range cleanupOrderRequests {
		t.Run(name, func(t *testing.T) {
			f := makeCleanupFixture(t, true)
			f.keepRemoteBranch()
			f.refuseRemove = errors.New("git worktree remove: fatal: 'app-7' is locked")

			result := f.cleanup(req)

			if step := expectStep(t, result, CleanupStepAgentTree, CleanupStateFailed); !strings.Contains(step.Error, "locked") {
				t.Errorf("agent worktree: %+v", step)
			}
			if step := expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped); step.Code != CleanupCodeTreeFailed {
				t.Errorf("local branch: %+v", step)
			}
			if step := expectStep(t, result, CleanupStepRemoteBranch, CleanupStateSkipped); step.Code != CleanupCodeLocalFirst || step.Branch != "feature/7-thing" {
				t.Errorf("remote branch: %+v", step)
			}
			if !f.remoteHasBranch() || f.gitIndex("--delete") >= 0 {
				t.Errorf("origin's branch was deleted before the worktree")
			}
			// The steps that do not depend on the worktree still run.
			expectStep(t, result, CleanupStepTicketClose, CleanupStateDone)
			expectStep(t, result, CleanupStepTicketDone, CleanupStateDone)

			// Clean up from the Leftovers group finishes the job, origin's branch last (#1090).
			f.refuseRemove = nil
			local := f.cleanup(CleanupRequest{Steps: []string{CleanupStepReviewTree, CleanupStepAgentTree, CleanupStepLocalBranch}})
			expectStep(t, local, CleanupStepAgentTree, CleanupStateDone)
			expectStep(t, local, CleanupStepLocalBranch, CleanupStateDone)
			remote := f.cleanup(CleanupRequest{Steps: []string{CleanupStepRemoteBranch}})
			if step := expectStep(t, remote, CleanupStepRemoteBranch, CleanupStateDone); step.Code != CleanupCodeDeleted {
				t.Errorf("remote branch from Leftovers: %+v", step)
			}
			if f.remoteHasBranch() {
				t.Errorf("origin's branch is still there after Clean up")
			}
		})
	}
}

// A worktree kept for its work keeps origin's branch: the risk the developer confirms counts its commits as pushed.
func TestCleanupKeepsOriginBranchWithAKeptWorktree(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.keepRemoteBranch()
	f.write(f.agent, "b.txt", "unsaved edit\n")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped)
	if step := expectStep(t, result, CleanupStepRemoteBranch, CleanupStateSkipped); step.Code != CleanupCodeLocalFirst {
		t.Errorf("remote branch: %+v", step)
	}
	if !f.remoteHasBranch() {
		t.Fatalf("origin's branch was deleted with the worktree kept")
	}

	// The sheet's Remove anyway sends the two local steps, then origin's branch.
	final := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch, CleanupStepRemoteBranch}, WorktreeConfirmed: agent.Confirm})
	expectStep(t, final, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, final, CleanupStepLocalBranch, CleanupStateDone)
	expectStep(t, final, CleanupStepRemoteBranch, CleanupStateDone)
	if f.remoteHasBranch() || exists(f.agent) {
		t.Errorf("after the confirmation: origin %v, worktree %v", f.remoteHasBranch(), exists(f.agent))
	}
}

// A local branch that stays (here, checked out in the main folder) keeps origin's branch too.
func TestCleanupKeepsOriginBranchWithTheLocalBranch(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.keepRemoteBranch()
	f.git(f.dir, "worktree", "remove", "--force", f.agent)
	f.git(f.dir, "checkout", "--quiet", "feature/7-thing")

	result := f.cleanup(CleanupRequest{})

	if step := expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped); step.Code != CleanupCodeInMainCheckout {
		t.Errorf("local branch: %+v", step)
	}
	if step := expectStep(t, result, CleanupStepRemoteBranch, CleanupStateSkipped); step.Code != CleanupCodeLocalFirst {
		t.Errorf("remote branch: %+v", step)
	}
	if !f.remoteHasBranch() {
		t.Errorf("origin's branch was deleted with the local branch kept")
	}
}

func TestMergeLeavesTheRemoteBranchToTheCleanup(t *testing.T) {
	for _, method := range []string{MergeMethodMerge, MergeMethodSquash, MergeMethodRebase} {
		args := strings.Join(mergeArgs("7", method, oidA), " ")
		if strings.Contains(args, "delete-branch") || args != "pr merge 7 --"+method+" --match-head-commit "+oidA {
			t.Errorf("%s: %s", method, args)
		}
	}
}
