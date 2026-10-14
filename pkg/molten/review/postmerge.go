// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"sync"
)

// The cleanup after the merge (FR-REV-013, DS-REV-010 steps 2 to 5) plugs in here: Validate (FR-REV-012, merge.go)
// lists the hook's steps in its plan sheet and, once GitHub merged the PR, runs it once. The hook never runs for a
// refused, failed or cancelled merge, and the merge itself is never retried whatever the hook reports.

const (
	CleanupPlanned = "planned"
	CleanupDone    = "done"
	CleanupSkipped = "skipped"
	CleanupFailed  = "failed"
)

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

// CleanupStep is one step of the cleanup as the plan sheet and the store show it: planned in the plan, then done,
// skipped (Detail says why) or failed (Detail carries the message).
type CleanupStep struct {
	Id     string `json:"id"`
	Label  string `json:"label"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// PostMerge is the cleanup after the merge (FR-REV-013).
type PostMerge interface {
	// Plan lists the steps Run would take, shown in the plan sheet; it must not change anything.
	Plan(ctx context.Context, pr MergedPr) []CleanupStep
	// Run takes the steps after the merge; report shows the progress (each call replaces the list) and the returned
	// list is the outcome kept in the review store.
	Run(ctx context.Context, pr MergedPr, report func(steps []CleanupStep)) []CleanupStep
}

type noPostMerge struct{}

func (noPostMerge) Plan(ctx context.Context, pr MergedPr) []CleanupStep {
	return nil
}

func (noPostMerge) Run(ctx context.Context, pr MergedPr, report func(steps []CleanupStep)) []CleanupStep {
	return nil
}

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
