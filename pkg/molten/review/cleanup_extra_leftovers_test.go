// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"os"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

const endedLockReason = "claude agent agent-x (pid 91001 start Sun Oct 25 16:46:51 2026)"

func (f *cleanupFixture) lockAgentTree(reason string) {
	f.t.Helper()
	f.git(f.dir, "worktree", "lock", "--reason", reason, f.agent)
}

func holderRuns(running bool) func() {
	return mission.SetLockHolderCheck(func(pid int32, startMs int64) bool { return running })
}

// #1121 (FR-REV-013 AC9): a worktree locked by a session that ended goes like an unlocked one, its branch with it.
func TestCleanupRemovesAWorktreeLockedByAnEndedSession(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.lockAgentTree(endedLockReason)
	defer holderRuns(false)()
	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}})
	if step := result.Step(CleanupStepAgentTree); step == nil || step.State != CleanupStateDone || step.Code != CleanupCodeRemoved {
		t.Fatalf("agent worktree: %+v", result.Steps)
	}
	if _, err := os.Stat(f.agent); !os.IsNotExist(err) {
		t.Fatalf("the worktree is still there: %v", err)
	}
	if step := result.Step(CleanupStepLocalBranch); step == nil || step.Code != CleanupCodeDeleted {
		t.Fatalf("local branch: %+v", step)
	}
}

// A lock whose holder still runs keeps the worktree, and Remove refuses an ended lock confirmed while its holder runs
// again (the plan is read again under the removal lock).
func TestCleanupKeepsAWorktreeLockedByARunningSession(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.lockAgentTree(endedLockReason)
	restore := holderRuns(true)
	defer restore()
	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}})
	if step := result.Step(CleanupStepAgentTree); step == nil || step.State != CleanupStateSkipped || step.Code != CleanupCodeLockHeld {
		t.Fatalf("agent worktree: %+v", result.Steps)
	}
	if step := result.Step(CleanupStepLocalBranch); step == nil || step.Code != CleanupCodeInKeptTree {
		t.Fatalf("local branch: %+v", step)
	}
	c := f.cleaner()
	plan, err := c.worktrees.Plan(mission.WorktreeRequest{Dir: f.agent})
	if err != nil || !plan.Locked || plan.LockEnded || plan.LockPid != 91001 {
		t.Fatalf("plan: %+v %v", plan, err)
	}
	_, err = c.worktrees.Remove(mission.WorktreeRemoveRequest{Dir: f.agent, Confirmed: &mission.WorktreeRisk{Sha: plan.Sha, EndedLock: true}})
	if err == nil {
		t.Fatalf("a running holder's lock was removed")
	}
	if _, err := os.Stat(f.agent); err != nil {
		t.Fatalf("the worktree went: %v", err)
	}
}

// A lock naming no process stays locked, as before #1121.
func TestCleanupKeepsAWorktreeLockedWithoutAPid(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.lockAgentTree("on a removable disk")
	defer holderRuns(false)()
	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree}})
	if step := result.Step(CleanupStepAgentTree); step == nil || step.Code != CleanupCodeLocked {
		t.Fatalf("agent worktree: %+v", result.Steps)
	}
}

// The copy-branches step deletes the PR's copies holding nothing new and names the others; it never runs unasked.
func TestCleanupDeletesThePrCopies(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.git(f.dir, "branch", "pr7", f.headOid)
	f.git(f.dir, "branch", "pr-7", f.headOid)
	f.git(f.dir, "worktree", "add", "--quiet", "-b", "pr07", f.root+"/copy", f.headOid)
	f.write(f.root+"/copy", "own.txt", "own\n")
	f.git(f.root+"/copy", "add", "own.txt")
	f.git(f.root+"/copy", "commit", "--quiet", "-m", "own work")
	f.git(f.dir, "worktree", "remove", f.root+"/copy")
	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepCopyBranches}, Copies: []string{"pr7", "pr-7", "pr07", "pr99"}})
	step := result.Step(CleanupStepCopyBranches)
	if step == nil || step.State != CleanupStateSkipped || step.Code != CleanupCodeCopiesKept || strings.Join(step.Names, ",") != "pr07" || step.Count != 2 {
		t.Fatalf("copies: %+v", result.Steps)
	}
	branches := f.git(f.dir, "branch", "--list", "pr*")
	if strings.Contains(branches, "pr7") || strings.Contains(branches, "pr-7") || !strings.Contains(branches, "pr07") {
		t.Fatalf("branches left: %q", branches)
	}
	result = f.cleanup(CleanupRequest{})
	if result.Step(CleanupStepCopyBranches) != nil {
		t.Fatalf("copy-branches ran without copies: %+v", result.Steps)
	}
}

// A PR closed without merging whose content is on the base: only its worktree and branches go, judged by content;
// the ticket is never touched. Its head counts for nothing: a commit that is only in that head keeps the worktree.
func TestCleanupOfAClosedPrInTheBase(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.prState = "CLOSED"
	result := f.cleanup(CleanupRequest{Closed: true})
	if step := result.Step(CleanupStepPr); step == nil || step.Code != CleanupCodeClosedPr {
		t.Fatalf("pr: %+v", result.Steps)
	}
	for _, id := range []string{CleanupStepTicketClose, CleanupStepTicketDone, CleanupStepLocalTrunk, CleanupStepOtherPrs} {
		if result.Step(id) != nil {
			t.Fatalf("%s ran for a closed PR: %+v", id, result.Steps)
		}
	}
	if step := result.Step(CleanupStepAgentTree); step == nil || step.Code != CleanupCodeRemoved {
		t.Fatalf("agent worktree: %+v", result.Steps)
	}
	if step := result.Step(CleanupStepLocalBranch); step == nil || step.Code != CleanupCodeDeleted {
		t.Fatalf("local branch: %+v", result.Steps)
	}
	if writes := f.ghWrites(); len(writes) != 0 {
		t.Fatalf("gh writes: %v", writes)
	}
	if calls := f.workflowCalls(); calls != "" {
		t.Fatalf("workflow calls: %q", calls)
	}

	g := makeCleanupFixture(t, false)
	g.prState = "CLOSED"
	g.write(g.agent, "late.txt", "late\n")
	g.git(g.agent, "add", "late.txt")
	g.git(g.agent, "commit", "--quiet", "-m", "late")
	g.prHead = g.git(g.agent, "rev-parse", "HEAD")
	result = g.cleanup(CleanupRequest{Closed: true, Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}})
	if step := result.Step(CleanupStepAgentTree); step == nil || step.Code != CleanupCodeKept || step.Loss == nil || step.Loss.CommitCount != 1 {
		t.Fatalf("a commit only in the closed head: %+v", result.Steps)
	}
	result = g.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree}})
	if step := result.Step(CleanupStepPr); step == nil || step.Code != CleanupCodeNotMerged {
		t.Fatalf("a closed PR without Closed: %+v", result.Steps)
	}
}
