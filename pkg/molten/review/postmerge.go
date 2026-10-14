// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"log"
	"sync"
)

// The cleanup after the merge (FR-REV-013, DS-REV-010 steps 2 to 5) plugs in here: Validate (FR-REV-012, merge.go)
// lists the hook's steps in its plan sheet and, once GitHub merged the PR, runs it once. The hook never runs for a
// refused, failed or cancelled merge, and the merge itself is never retried whatever the hook reports. wavesrv installs
// the review Service (Start): its Run is Service.Cleanup, whose outcome the review store keeps (State.Cleanup).

// MergedPr is the PR the hook works on. In Plan, MergedOid is empty and HeadOid is the head the plan was made for;
// in Run, HeadOid is the head GitHub merged (after a rebase by GitHub, the rebased head) and MergedOid the base's
// new tip when gh reported it.
type MergedPr struct {
	Dir       string `json:"dir"`
	Repo      string `json:"repo"`
	Number    int    `json:"number"`
	Ticket    int    `json:"ticket,omitempty"`
	Url       string `json:"url,omitempty"`
	HeadRef   string `json:"headref"`
	BaseRef   string `json:"baseref"`
	HeadOid   string `json:"headoid"`
	MergedOid string `json:"mergedoid,omitempty"`
}

// PostMerge is the cleanup after the merge (FR-REV-013).
type PostMerge interface {
	// Plan lists the steps Run would take (CleanupStatePlanned), shown in the plan sheet; it must not change anything.
	Plan(ctx context.Context, pr MergedPr) []CleanupStepResult
	// Run takes the steps after the merge and records their outcome in the review store.
	Run(ctx context.Context, pr MergedPr)
}

type noPostMerge struct{}

func (noPostMerge) Plan(ctx context.Context, pr MergedPr) []CleanupStepResult {
	return nil
}

func (noPostMerge) Run(ctx context.Context, pr MergedPr) {}

var postMergeLock sync.Mutex
var postMerge PostMerge = noPostMerge{}

// SetPostMerge installs the cleanup after the merge (FR-REV-013); nil puts back the default, which does nothing.
func SetPostMerge(hook PostMerge) {
	postMergeLock.Lock()
	defer postMergeLock.Unlock()
	if hook == nil {
		hook = noPostMerge{}
	}
	postMerge = hook
}

func currentPostMerge() PostMerge {
	postMergeLock.Lock()
	defer postMergeLock.Unlock()
	return postMerge
}

// Plan lists every step of the cleanup: which ones apply is only known once the PR is merged (the branch, the
// worktrees and the other PRs then), and each one reports done, skipped or failed.
func (s *Service) Plan(ctx context.Context, pr MergedPr) []CleanupStepResult {
	if s.cleaner == nil {
		return nil
	}
	rtn := make([]CleanupStepResult, 0, len(CleanupSteps))
	for _, id := range CleanupSteps {
		step := CleanupStepResult{Id: id, State: CleanupStatePlanned}
		switch id {
		case CleanupStepTicketClose, CleanupStepTicketDone:
			if pr.Ticket > 0 {
				step.Message = fmt.Sprintf("#%d", pr.Ticket)
			}
		case CleanupStepLocalBranch, CleanupStepRemoteBranch:
			step.Message = pr.HeadRef + ", when its content is on " + pr.BaseRef
		case CleanupStepOtherPrs:
			step.Message = "rebased by GitHub on " + pr.BaseRef
		}
		rtn = append(rtn, step)
	}
	return rtn
}

// Run is the cleanup of the PR Validate merged; Service.Cleanup records its outcome.
func (s *Service) Run(ctx context.Context, pr MergedPr) {
	if s.cleaner == nil {
		return
	}
	_, err := s.Cleanup(ctx, CleanupRequest{Dir: pr.Dir, Repo: pr.Repo, Number: pr.Number, Ticket: pr.Ticket})
	if err != nil {
		log.Printf("%s %s#%d: the cleanup after the merge: %v\n", logPrefix, pr.Repo, pr.Number, err)
	}
}
