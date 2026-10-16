// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// The run's state machine (DS-REV-017): each PR in the order the modal showed goes queued → checking → (rebasing by the
// agent → waiting for its checks) → merging → merged, or stops the run, or is skipped. Every step starts from a fresh
// read of the PR on GitHub, so the run follows what really happened (a PR merged elsewhere, a push, a base that moved).

const (
	batchMerged = iota
	batchSkipped
	batchStopped
	batchCancelled
	// batchAgain: read the PR again (the head or the base moved under the merge).
	batchAgain
)

// batchStop is why a PR stops the run (or is skipped): a reason and its data.
type batchStop struct {
	reason string
	names  []string
	note   string
	detail string
	code   string
}

func (b *BatchRunner) cancelAsked(ctl *batchCtl) bool {
	b.lock.Lock()
	defer b.lock.Unlock()
	return ctl.run.CancelAsked
}

func (b *BatchRunner) setItem(ctl *batchCtl, i int, fn func(item *BatchItem)) BatchRun {
	return b.change(ctl, func(run *BatchRun) { fn(&run.Items[i]) })
}

// sleep waits d, false when the run was cancelled meanwhile.
func (b *BatchRunner) sleep(ctx context.Context, d time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	return b.env.Sleep(ctx, d)
}

func (b *BatchRunner) loop(ctx context.Context, ctl *batchCtl, tabName string) {
	agent := &batchAgent{tabName: tabName}
	ended := false
	count := len(b.read(ctl).Items)
	for i := 0; i < count && !ended; i++ {
		if b.cancelAsked(ctl) {
			break
		}
		b.change(ctl, func(run *BatchRun) {
			run.Current = i
			run.Items[i].StartedAt = b.env.Now().UnixMilli()
		})
		override := false
		for {
			out := b.process(ctx, ctl, agent, i, override)
			if out == batchCancelled {
				ended = true
				break
			}
			if out != batchStopped {
				break
			}
			decision := b.pause(ctl, i)
			b.resolveStopNotice(ctl)
			if decision == BatchDecisionRetry || decision == BatchDecisionOverride {
				override = decision == BatchDecisionOverride
				b.change(ctl, func(run *BatchRun) {
					if run.State == BatchPaused {
						run.State = BatchRunning
					}
					it := &run.Items[i]
					it.State, it.Reason, it.Names, it.Note, it.Detail, it.Code = BatchItemChecking, "", nil, "", "", ""
				})
				continue
			}
			b.change(ctl, func(run *BatchRun) {
				if run.State == BatchPaused {
					run.State = BatchRunning
				}
				it := &run.Items[i]
				it.State, it.ByYou, it.EndedAt = BatchItemSkipped, true, b.env.Now().UnixMilli()
			})
			if decision != BatchDecisionSkip {
				ended = true
			}
			break
		}
	}
	b.finish(ctl, agent, ended)
}

// pause stops the run on PR i and waits for the developer's decision (a cancel ends it).
func (b *BatchRunner) pause(ctl *batchCtl, i int) string {
	// A decision left from before this stop (a cancel's) is not this stop's.
	select {
	case <-ctl.decide:
	default:
	}
	if b.cancelAsked(ctl) {
		return BatchDecisionEnd
	}
	// The notification goes first: a window that sees the run paused finds it there.
	b.notifyStop(ctl, b.read(ctl), i)
	b.change(ctl, func(run *BatchRun) {
		if !run.CancelAsked {
			run.State = BatchPaused
		}
	})
	if b.cancelAsked(ctl) {
		return BatchDecisionEnd
	}
	return <-ctl.decide
}

func (b *BatchRunner) stopItem(ctl *batchCtl, i int, stop batchStop) int {
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Reason, it.Names, it.Note, it.Detail, it.Code = BatchItemStopped, stop.reason, stop.names, stop.note, stop.detail, stop.code
		it.Waiting = false
	})
	log.Printf("%s batch: #%d stopped: %s %s%s\n", logPrefix, b.read(ctl).Items[i].Number, stop.reason, strings.Join(stop.names, ","), stop.detail)
	return batchStopped
}

func (b *BatchRunner) skipItem(ctl *batchCtl, i int, reason string) int {
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Reason, it.EndedAt = BatchItemSkipped, reason, b.env.Now().UnixMilli()
	})
	return batchSkipped
}

func (b *BatchRunner) viewPr(dir string, k PrKey) (ghMergePr, error) {
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	var pr ghMergePr
	if b.env.Gh == nil {
		return pr, noGhError()
	}
	out, err := b.env.Gh(ctx, dir, "pr", "view", strconv.Itoa(k.Number), "--json", prViewFields, "--repo", k.Repo)
	if err != nil {
		return pr, fmt.Errorf("%s", maskTokens(err.Error()))
	}
	if err := json.Unmarshal(out, &pr); err != nil {
		return pr, fmt.Errorf("gh pr view answered something unreadable: %v", err)
	}
	if pr.Number != k.Number || !isOid(pr.HeadRefOid) {
		return pr, fmt.Errorf("gh pr view did not answer pull request #%d", k.Number)
	}
	return pr, nil
}

func missingNames(expected []string, checks []mission.ReviewCheck) []string {
	present := map[string]bool{}
	for _, c := range checks {
		present[c.Name] = true
	}
	var rtn []string
	for _, name := range expected {
		if !present[name] {
			rtn = append(rtn, name)
		}
	}
	return rtn
}

// process takes PR i to its merge, a stop or a skip. A PR that merges cleanly with green checks is merged at once; one
// that conflicts goes to the agent, then waits for its checks on the rebased head; one whose checks fail stops the run.
func (b *BatchRunner) process(ctx context.Context, ctl *batchCtl, agent *batchAgent, i int, override bool) int {
	run := b.read(ctl)
	item := run.Items[i]
	k := PrKey{Repo: run.Repo, Number: item.Number}
	var computingSince, waitingSince time.Time
	var expected []string
	readErrors, blockedPolls, tries := 0, 0, 0
	for {
		if b.cancelAsked(ctl) {
			return batchCancelled
		}
		pr, err := b.viewPr(run.Dir, k)
		if err != nil {
			readErrors++
			if readErrors >= maxBatchReadErrors {
				return b.stopItem(ctl, i, batchStop{reason: BatchReasonRead, detail: err.Error()})
			}
			if !b.sleep(ctx, b.env.Every) {
				return batchCancelled
			}
			continue
		}
		readErrors = 0
		b.setItem(ctl, i, func(it *BatchItem) {
			it.Head = pr.HeadRefOid
			if it.State != BatchItemWaitingChecks {
				it.State = BatchItemChecking
			}
		})
		switch strings.ToUpper(pr.State) {
		case "MERGED":
			return b.skipItem(ctl, i, BatchReasonMergedAway)
		case "CLOSED":
			return b.skipItem(ctl, i, BatchReasonClosed)
		}
		if pr.IsDraft {
			return b.stopItem(ctl, i, batchStop{reason: BatchReasonDraft})
		}
		ci, _ := mission.ParseReviewChecks(pr.StatusCheckRollup)
		switch mission.ReviewConflictOf(pr.Mergeable, pr.MergeStateStatus) {
		case mission.ReviewConflictComputing:
			if computingSince.IsZero() {
				computingSince = b.env.Now()
			} else if b.env.Now().Sub(computingSince) > b.env.ComputeLimit {
				return b.stopItem(ctl, i, batchStop{reason: BatchReasonUnknown})
			}
			if !b.sleep(ctx, b.env.Every) {
				return batchCancelled
			}
			continue
		case mission.ReviewConflictConflicting:
			computingSince = time.Time{}
			if b.read(ctl).Items[i].Rebases >= maxBatchRebases {
				return b.stopItem(ctl, i, batchStop{reason: BatchReasonConflict})
			}
			if names := checkNames(ci.Checks); len(names) > 0 {
				expected = names
			}
			stop, out := b.rebase(ctl, agent, i, pr)
			if out == batchCancelled {
				return batchCancelled
			}
			if out == batchStopped {
				return b.stopItem(ctl, i, stop)
			}
			b.change(ctl, func(run *BatchRun) {
				run.Items[i].Rebases++
				run.Items[i].CiRuns++
				run.CiRuns++
			})
			waitingSince = time.Time{}
			continue
		}
		computingSince = time.Time{}
		if failing := namesIn(ci.Checks, mission.ReviewCheckFailure); len(failing) > 0 {
			return b.stopItem(ctl, i, batchStop{reason: BatchReasonFailing, names: failing})
		}
		if ci.Pending > 0 || len(missingNames(expected, ci.Checks)) > 0 {
			b.setItem(ctl, i, func(it *BatchItem) { it.State = BatchItemWaitingChecks })
			if waitingSince.IsZero() {
				waitingSince = b.env.Now()
			} else if b.env.Now().Sub(waitingSince) > b.ciLimit() {
				return b.stopItem(ctl, i, batchStop{reason: BatchReasonCiTimeout, names: namesIn(ci.Checks, mission.ReviewCheckPending)})
			}
			if !b.sleep(ctx, b.env.Every) {
				return batchCancelled
			}
			continue
		}
		if strings.EqualFold(pr.MergeStateStatus, "BLOCKED") {
			// GitHub may still say BLOCKED for a little while after the last check passed.
			blockedPolls++
			if blockedPolls >= maxBlockedPolls {
				return b.stopItem(ctl, i, batchStop{reason: BatchReasonBlocked})
			}
			if !b.sleep(ctx, b.env.Every) {
				return batchCancelled
			}
			continue
		}
		blockedPolls = 0
		out, stop := b.merge(ctl, i, k, pr, override)
		if out != batchAgain {
			if out == batchStopped {
				return b.stopItem(ctl, i, stop)
			}
			return out
		}
		tries++
		if tries >= maxBatchMergeTries {
			if stop.reason == "" {
				stop.reason = BatchReasonHeadMoved
			}
			return b.stopItem(ctl, i, stop)
		}
	}
}

func (b *BatchRunner) ciLimit() time.Duration {
	if b.env.Merger != nil && b.env.Merger.ciTimeout > 0 {
		return b.env.Merger.ciTimeout
	}
	return defaultCiTimeout
}

// remaining: the PRs after i not merged or skipped yet; the cleanup after each merge leaves them to the batch.
func (b *BatchRunner) remaining(ctl *batchCtl, i int) []int {
	run := b.read(ctl)
	var rtn []int
	for _, it := range run.Items[i+1:] {
		if !batchItemEnded(it.State) {
			rtn = append(rtn, it.Number)
		}
	}
	return rtn
}

// merge goes through Validate's path (FR-REV-012): a plan read fresh, then the merge bound to its head, with the
// repository's method; its cleanup runs after it as after a manual merge.
func (b *BatchRunner) merge(ctl *batchCtl, i int, k PrKey, pr ghMergePr, override bool) (int, batchStop) {
	m := b.env.Merger
	if m == nil {
		return batchStopped, batchStop{reason: BatchReasonMergeFailed, detail: "Validate is not available"}
	}
	run := b.read(ctl)
	item := run.Items[i]
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	plan, err := m.Plan(ctx, MergePlanRequest{PrKey: k, Dir: run.Dir, Ticket: item.Ticket})
	cancel()
	if err != nil {
		return batchStopped, batchStop{reason: BatchReasonRead, detail: err.Error()}
	}
	if plan.HeadOid != pr.HeadRefOid {
		return batchAgain, batchStop{reason: BatchReasonHeadMoved}
	}
	if !plan.CanMerge {
		blocking := blockingOf(plan.Checks)
		switch {
		case blocking == nil:
			return batchAgain, batchStop{}
		case blocking.Id == CheckIdCi && blocking.State == CheckFail:
			return batchStopped, batchStop{reason: BatchReasonFailing, names: blocking.Names}
		case blocking.Id == CheckIdBlocked:
			return batchStopped, batchStop{reason: BatchReasonBlocked}
		case blocking.Id == CheckIdOpen && blocking.Code == CheckCodeDraft:
			return batchStopped, batchStop{reason: BatchReasonDraft}
		}
		return batchAgain, batchStop{reason: BatchReasonMergeFailed, code: blocking.Code}
	}
	if len(plan.Warnings) > 0 && !override {
		return batchStopped, batchStop{reason: BatchReasonWarnings, names: plan.Warnings}
	}
	method := run.Method
	if !hasMethod(plan.Methods, method) {
		method = ""
	}
	b.setItem(ctl, i, func(it *BatchItem) { it.State = BatchItemMerging })
	if _, err := m.Merge(MergeRequest{PrKey: k, PlanId: plan.Id, Override: override, Method: method, Batch: b.remaining(ctl, i)}); err != nil {
		return batchStopped, batchStop{reason: BatchReasonMergeFailed, detail: err.Error()}
	}
	final := b.waitMerge(ctl, k)
	if final.Updated {
		b.change(ctl, func(run *BatchRun) {
			run.Items[i].CiRuns++
			run.CiRuns++
		})
	}
	switch final.State {
	case MergeMerged:
		b.setItem(ctl, i, func(it *BatchItem) {
			it.State, it.EndedAt = BatchItemMerged, b.env.Now().UnixMilli()
			if final.Head != "" {
				it.Head = final.Head
			}
		})
		return batchMerged, batchStop{}
	case MergeCancelled:
		return batchCancelled, batchStop{}
	case MergeRefused:
		if final.Refused == RefusedCheck && final.Blocking != nil && final.Blocking.Id == CheckIdCi && final.Blocking.State == CheckFail {
			return batchStopped, batchStop{reason: BatchReasonFailing, names: final.Blocking.Names}
		}
		return batchAgain, batchStop{reason: BatchReasonMergeFailed, code: final.Code}
	}
	switch final.Code {
	case MergeCodeCiFailed:
		return batchStopped, batchStop{reason: BatchReasonFailing, names: final.Names}
	case MergeCodeConflict:
		return batchAgain, batchStop{reason: BatchReasonConflict}
	case MergeCodeCiTimeout:
		return batchStopped, batchStop{reason: BatchReasonCiTimeout}
	}
	return batchStopped, batchStop{reason: BatchReasonMergeFailed, code: final.Code, detail: final.Error}
}

// waitMerge waits for Validate's merge to end. A cancel stops it only while GitHub updates the branch or CI runs on
// it: a merge call already sent is not undone.
func (b *BatchRunner) waitMerge(ctl *batchCtl, k PrKey) MergeRecord {
	m := b.env.Merger
	done := make(chan struct{})
	go func() {
		m.wait(k)
		close(done)
	}()
	cancelled := false
	for {
		select {
		case <-done:
			state, err := m.store.Get(k)
			if err != nil || state.Merge == nil {
				return MergeRecord{State: MergeFailed, Code: MergeCodeReread}
			}
			return *state.Merge
		case <-time.After(b.env.AgentEvery):
		}
		if cancelled || !b.cancelAsked(ctl) {
			continue
		}
		state, err := m.store.Get(k)
		if err == nil && state.Merge != nil && (state.Merge.State == MergeUpdating || state.Merge.State == MergeWaitingCi) {
			cancelled = m.Cancel(k) == nil
		}
	}
}

// finish ends the run: the PRs not reached are skipped, the agent's terminal and worktree go when nothing would be
// lost, and a notification sums it up.
func (b *BatchRunner) finish(ctl *batchCtl, agent *batchAgent, ended bool) {
	b.cleanAgent(ctl, agent)
	run := b.change(ctl, func(run *BatchRun) {
		cancelled := run.CancelAsked || ended
		for i := range run.Items {
			it := &run.Items[i]
			if batchItemEnded(it.State) {
				continue
			}
			switch {
			case it.State == BatchItemStopped:
				it.State = BatchItemSkipped
			case it.State == BatchItemQueued:
				it.State, it.Reason = BatchItemSkipped, BatchReasonNotReached
			default:
				it.State, it.Reason = BatchItemSkipped, BatchReasonCancelled
			}
			it.Waiting = false
			if it.EndedAt == 0 && it.StartedAt != 0 {
				it.EndedAt = b.env.Now().UnixMilli()
			}
		}
		run.State = BatchDone
		if cancelled {
			run.State = BatchCancelled
		}
		run.Current = -1
		run.EndedAt = b.env.Now().UnixMilli()
	})
	b.resolveStopNotice(ctl)
	b.notifyEnd(run)
	log.Printf("%s batch %s: %s, %d CI runs redone\n", logPrefix, run.Id, run.State, run.CiRuns)
}
