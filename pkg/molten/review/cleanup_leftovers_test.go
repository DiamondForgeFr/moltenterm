// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// #716: a worktree already gone, or left half-deleted by a removal git accepted, is not an error.

func (f *cleanupFixture) branchExists(branch string) bool {
	_, err := f.run(context.Background(), f.dir, "git", "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

func TestCleanupAgentTreeRemovedBeforeTheMerge(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.git(f.dir, "worktree", "remove", f.agent)

	result := f.cleanup(CleanupRequest{PlannedAgentTree: f.agent})

	step := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if step.Code != CleanupCodeAlreadyGone || step.Path != f.agent {
		t.Errorf("agent worktree: %+v", step)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	if f.branchExists("feature/7-thing") {
		t.Errorf("the branch was kept")
	}
}

func TestCleanupAgentTreeFolderDeletedByHand(t *testing.T) {
	f := makeCleanupFixture(t, true)
	// git still lists the worktree; only its folder went.
	if err := os.RemoveAll(f.agent); err != nil {
		t.Fatal(err)
	}

	result := f.cleanup(CleanupRequest{PlannedAgentTree: f.agent})

	if step := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped); step.Code != CleanupCodeAlreadyGone {
		t.Errorf("agent worktree: %+v", step)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	if f.branchExists("feature/7-thing") {
		t.Errorf("the branch was kept")
	}
}

func TestCleanupAgentTreeLeftoversAreRemoved(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.afterRemove = f.recreateDsStore
	// The first try at the leftovers meets a file written while it deletes; the second one ends the job.
	first := true
	f.removeAll = func(path string) error {
		if first {
			first = false
			os.RemoveAll(path)
			f.write(path, ".DS_Store", "metadata again")
			return errors.New("unlinkat " + path + ": directory not empty")
		}
		return os.RemoveAll(path)
	}

	result := f.cleanup(CleanupRequest{})

	step := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if step.Code != CleanupCodeLeftoversRemoved || step.Error != "" {
		t.Errorf("agent worktree: %+v", step)
	}
	if exists(f.agent) {
		t.Errorf("the leftovers stay")
	}
	if f.removeAlls != 2 || f.waits != 1 {
		t.Errorf("tries: %d removals, %d waits", f.removeAlls, f.waits)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
}

func TestCleanupAgentTreeLeftoverStaysAsAWarning(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.afterRemove = f.recreateDsStore
	f.removeAll = func(path string) error {
		return errors.New("unlinkat " + path + ": directory not empty")
	}

	result := f.cleanup(CleanupRequest{})

	step := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if step.Code != CleanupCodeLeftover || step.Path != f.agent || !strings.Contains(step.Error, "directory not empty") {
		t.Errorf("agent worktree: %+v", step)
	}
	if f.removeAlls != 3 || f.waits != 2 {
		t.Errorf("tries: %d removals, %d waits", f.removeAlls, f.waits)
	}
	// The worktree is gone for git: the branch is not held back.
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)

	// Remove again, once the folder lets go: only the folder the step recorded.
	s := &Service{store: MakeStore(t.TempDir()), cleaner: f.cleaner()}
	if _, _, err := s.store.SetCleanup(result); err != nil {
		t.Fatal(err)
	}
	f.removeAll = nil
	other := filepath.Join(f.root, "elsewhere")
	f.write(other, "keep.txt", "keep")
	for _, req := range []CleanupRequest{
		{Steps: []string{CleanupStepAgentTree}, Leftover: other},
		{Steps: []string{CleanupStepReviewTree}, Leftover: f.agent},
		{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}, Leftover: f.agent},
	} {
		req.Dir, req.Repo, req.Number = f.dir, cleanupRepo, 7
		if _, err := s.Cleanup(context.Background(), req); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
	if !exists(filepath.Join(other, "keep.txt")) || !exists(f.agent) {
		t.Fatalf("a refused Remove again removed something")
	}
	again, err := s.Cleanup(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7,
		Steps: []string{CleanupStepAgentTree}, Leftover: f.agent})
	if err != nil {
		t.Fatal(err)
	}
	if step := expectStep(t, again, CleanupStepAgentTree, CleanupStateDone); step.Code != CleanupCodeLeftoversRemoved {
		t.Errorf("remove again: %+v", step)
	}
	if exists(f.agent) {
		t.Errorf("the leftover folder stays")
	}
}

func TestCleanupAgentTreeGitRefusesStillFails(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.refuseRemove = errors.New("git worktree remove: fatal: boom")

	result := f.cleanup(CleanupRequest{})

	step := expectStep(t, result, CleanupStepAgentTree, CleanupStateFailed)
	if !strings.Contains(step.Error, "boom") {
		t.Errorf("agent worktree: %+v", step)
	}
	if step := expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped); step.Code != CleanupCodeTreeFailed {
		t.Errorf("branch: %+v", step)
	}
	if f.removeAlls != 0 || !exists(filepath.Join(f.agent, "b.txt")) {
		t.Errorf("a worktree git still lists was touched: %d removals", f.removeAlls)
	}
}

func TestCleanupReviewTreeLeftovers(t *testing.T) {
	f := makeCleanupFixture(t, true)
	review := reviewsession.ReviewTreeDir(f.dataDir, f.dir, 7)
	f.git(f.dir, "worktree", "add", "--quiet", "--detach", review, f.headOid)
	f.afterRemove = f.recreateDsStore

	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepReviewTree}})

	if step := expectStep(t, result, CleanupStepReviewTree, CleanupStateDone); step.Code != CleanupCodeLeftoversRemoved {
		t.Errorf("review worktree: %+v", step)
	}
	if exists(review) {
		t.Errorf("the leftovers stay")
	}

	// A folder an earlier removal left, with no .git and no longer listed: removed as leftovers too.
	f.write(review, ".DS_Store", "metadata")
	result = f.cleanup(CleanupRequest{Steps: []string{CleanupStepReviewTree}})
	if step := expectStep(t, result, CleanupStepReviewTree, CleanupStateDone); step.Code != CleanupCodeLeftoversRemoved {
		t.Errorf("earlier leftovers: %+v", step)
	}
	if exists(review) {
		t.Errorf("the earlier leftovers stay")
	}
}
