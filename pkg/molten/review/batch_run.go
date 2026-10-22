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

// The queue's state machine (DS-REV-017): the first PR waiting, in the suggested order, goes queued → checking →
// (rebasing by the agent → waiting for its checks) → merging → merged; a failing check sets it aside (failed, watched on
// its head), another stop takes it out of the queue for the developer, a push the queue did not make voids it. Every
// step starts from a fresh read of the PR on GitHub, so the queue follows what really happened (a PR merged elsewhere, a
// push, a base that moved).

const (
	batchMerged = iota
	batchSkipped
	batchStopped
	batchCancelled
	// batchAgain: read the PR again (the head or the base moved under the merge).
	batchAgain
	// batchVoided: a push the queue did not make; the validation no longer holds.
	batchVoided
)

// batchStop is why a PR stops (or is skipped): a reason and its data.
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

// stopAsked: the queue is cancelled, or the developer withdrew PR i.
func (b *BatchRunner) stopAsked(ctl *batchCtl, i int) bool {
	b.lock.Lock()
	defer b.lock.Unlock()
	return ctl.run.CancelAsked || ctl.withdrawn[ctl.run.Items[i].Number]
}

func (b *BatchRunner) setItem(ctl *batchCtl, i int, fn func(item *BatchItem)) BatchRun {
	return b.change(ctl, func(run *BatchRun) { fn(&run.Items[i]) })
}

// sleep waits d, false when the wait was cancelled meanwhile.
func (b *BatchRunner) sleep(ctx context.Context, d time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	return b.env.Sleep(ctx, d)
}

// next: the first PR waiting its turn, -1 when none; it becomes the current one.
func (b *BatchRunner) next(ctl *batchCtl) int {
	b.lock.Lock()
	defer b.lock.Unlock()
	for i, it := range ctl.run.Items {
		if it.State == BatchItemQueued {
			return i
		}
	}
	return -1
}

func (b *BatchRunner) hasFailed(ctl *batchCtl) bool {
	b.lock.Lock()
	defer b.lock.Unlock()
	for _, it := range ctl.run.Items {
		if it.State == BatchItemFailed {
			return true
		}
	}
	return false
}

// tryFinish ends the queue when nothing waits in it any more, atomically with Add: a PR joining after that starts a
// new queue.
func (b *BatchRunner) tryFinish(ctl *batchCtl) bool {
	b.lock.Lock()
	defer b.lock.Unlock()
	if !ctl.run.CancelAsked {
		for _, it := range ctl.run.Items {
			if itemOpen(it.State) {
				return false
			}
		}
	}
	ctl.run.State = BatchDone
	if ctl.run.CancelAsked {
		ctl.run.State = BatchCancelled
	}
	return true
}

// idle waits for a PR to join, or for the next look at the failed ones.
func (b *BatchRunner) idle(ctx context.Context, ctl *batchCtl) bool {
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-ctl.wake:
			cancel()
		case <-wctx.Done():
		}
	}()
	b.env.Sleep(wctx, b.env.Every)
	return ctx.Err() == nil
}

func (b *BatchRunner) loop(ctx context.Context, ctl *batchCtl) {
	for {
		if b.cancelAsked(ctl) {
			break
		}
		b.recheckFailed(ctl)
		i := b.next(ctl)
		if i < 0 {
			if !b.hasFailed(ctl) && b.tryFinish(ctl) {
				break
			}
			if !b.idle(ctx, ctl) {
				break
			}
			continue
		}
		b.runItem(ctx, ctl, i)
	}
	b.finish(ctl)
}

// runItem takes PR i through its turn.
func (b *BatchRunner) runItem(ctx context.Context, ctl *batchCtl, i int) {
	itemCtx, itemStop := context.WithCancel(ctx)
	defer itemStop()
	b.lock.Lock()
	ctl.itemStop = itemStop
	b.lock.Unlock()
	b.change(ctl, func(run *BatchRun) {
		run.Current = i
		run.Items[i].StartedAt = b.env.Now().UnixMilli()
		run.Items[i].State = BatchItemChecking
	})
	out := b.process(itemCtx, ctl, i)
	b.lock.Lock()
	ctl.itemStop = nil
	number := ctl.run.Items[i].Number
	withdrawn := ctl.withdrawn[number]
	delete(ctl.withdrawn, number)
	preempted := ctl.preempt && !withdrawn && !ctl.run.CancelAsked
	ctl.preempt = false
	order := ctl.order
	b.lock.Unlock()
	b.change(ctl, func(run *BatchRun) {
		run.Current = -1
		it := &run.Items[i]
		it.Waiting = false
		if out == batchCancelled && preempted && !batchItemEnded(it.State) {
			// A PR before it in the suggested order joined: it waits its turn again.
			it.State = BatchItemQueued
			reorder(run.Items, -1, order)
			return
		}
		if out == batchCancelled && !batchItemEnded(it.State) {
			it.State, it.Reason, it.EndedAt = BatchItemWithdrawn, BatchReasonCancelled, b.env.Now().UnixMilli()
			if withdrawn {
				it.Reason, it.ByYou = BatchReasonWithdrawn, true
			}
		}
	})
	run := b.read(ctl)
	switch out {
	case batchMerged:
		b.notifyMerged(run, i)
	case batchStopped:
		b.notifyStop(run, i)
	case batchVoided:
		b.notifyVoided(run, i)
	}
}

func (b *BatchRunner) stopItem(ctl *batchCtl, i int, stop batchStop) int {
	state := BatchItemStopped
	if stop.reason == BatchReasonFailing {
		state = BatchItemFailed
	}
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Reason, it.Names, it.Note, it.Detail, it.Code = state, stop.reason, stop.names, stop.note, stop.detail, stop.code
		it.Waiting = false
		if state == BatchItemStopped {
			it.EndedAt = b.env.Now().UnixMilli()
		}
	})
	log.Printf("%s queue: #%d %s: %s %s%s\n", logPrefix, b.read(ctl).Items[i].Number, state, stop.reason, strings.Join(stop.names, ","), stop.detail)
	return batchStopped
}

func (b *BatchRunner) skipItem(ctl *batchCtl, i int, reason string) int {
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Reason, it.EndedAt = BatchItemSkipped, reason, b.env.Now().UnixMilli()
	})
	return batchSkipped
}

func (b *BatchRunner) voidItem(ctl *batchCtl, i int, head string) int {
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Reason, it.Head, it.EndedAt = BatchItemVoided, BatchReasonPushed, head, b.env.Now().UnixMilli()
	})
	log.Printf("%s queue: #%d voided, pushed %s after the validation\n", logPrefix, b.read(ctl).Items[i].Number, shortHead(head))
	return batchVoided
}

// ownHead tells whether head is the one the validation is bound to: the reviewed head, or one the queue pushed itself
// (the agent's conflict rebase, GitHub's update of the branch by Validate's merge, as the review store recorded it).
func (b *BatchRunner) ownHead(ctl *batchCtl, i int, k PrKey, head string) bool {
	item := b.read(ctl).Items[i]
	if item.Valid == "" || head == item.Valid {
		return true
	}
	m := b.env.Merger
	if m == nil || m.store == nil {
		return false
	}
	state, err := m.store.Get(k)
	if err != nil || state.Merge == nil {
		return false
	}
	rec := state.Merge
	if !rec.Updated || rec.PlanHead != item.Valid || rec.Head != head {
		return false
	}
	b.setItem(ctl, i, func(it *BatchItem) { it.Valid = head })
	return true
}

// recheckFailed looks again at the PRs set aside on a failing check: one whose checks were rerun on the same head (a
// flaky job rerun by the agent, #896) comes back without a new validation; a push voids it; merged or closed elsewhere,
// it leaves.
func (b *BatchRunner) recheckFailed(ctl *batchCtl) {
	run := b.read(ctl)
	for i, it := range run.Items {
		if it.State != BatchItemFailed || b.cancelAsked(ctl) {
			continue
		}
		k := PrKey{Repo: run.Repo, Number: it.Number}
		pr, err := b.viewPr(run.Dir, k)
		if err != nil {
			continue
		}
		switch strings.ToUpper(pr.State) {
		case "MERGED":
			b.skipItem(ctl, i, BatchReasonMergedAway)
			b.resolvePrNotice(run, it.Number)
			continue
		case "CLOSED":
			b.skipItem(ctl, i, BatchReasonClosed)
			b.resolvePrNotice(run, it.Number)
			continue
		}
		if !b.ownHead(ctl, i, k, pr.HeadRefOid) {
			b.voidItem(ctl, i, pr.HeadRefOid)
			b.resolvePrNotice(run, it.Number)
			b.notifyVoided(b.read(ctl), i)
			continue
		}
		ci, _ := mission.ParseReviewChecks(pr.StatusCheckRollup)
		if len(namesIn(ci.Checks, mission.ReviewCheckFailure)) > 0 {
			continue
		}
		b.setItem(ctl, i, func(it *BatchItem) {
			it.State, it.Reason, it.Names = BatchItemQueued, "", nil
		})
		b.resolvePrNotice(run, it.Number)
		log.Printf("%s queue: #%d back, its checks were rerun on the validated head\n", logPrefix, it.Number)
	}
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

// checkGroup: the workflow a check belongs to; a check outside GitHub Actions (a commit status, another app) is its own.
func checkGroup(c mission.ReviewCheck) string {
	if c.Workflow != "" {
		return "w\x00" + c.Workflow
	}
	return "c\x00" + c.Name
}

// missingChecks: the checks of the head before a rebase that the rebased head does not show yet. A push reruns only
// the workflows it triggers: one that ran through another event (sync-review, pull_request_target on opened only,
// #887) never comes back. So once settled (the push's workflows had time to start), a missing check is still waited
// for only when its workflow runs on the new head, as a job created after the others.
func missingChecks(expected []mission.ReviewCheck, checks []mission.ReviewCheck, settled bool) []string {
	present := map[string]bool{}
	running := map[string]bool{}
	for _, c := range checks {
		present[checkGroup(c)+"\x00"+c.Name] = true
		running[checkGroup(c)] = true
	}
	var rtn []string
	for _, c := range expected {
		if present[checkGroup(c)+"\x00"+c.Name] {
			continue
		}
		if settled && !running[checkGroup(c)] {
			continue
		}
		rtn = append(rtn, c.Name)
	}
	return rtn
}

// process takes PR i to its merge, a stop or a skip. A PR that merges cleanly with green checks is merged at once; one
// that conflicts goes to the agent, then waits for its checks on the rebased head; one whose checks fail is set aside.
// The checks the developer chose to wait for have no time limit.
func (b *BatchRunner) process(ctx context.Context, ctl *batchCtl, i int) int {
	run := b.read(ctl)
	item := run.Items[i]
	k := PrKey{Repo: run.Repo, Number: item.Number}
	var computingSince, rebasedAt time.Time
	var expected []mission.ReviewCheck
	readErrors, blockedPolls, tries := 0, 0, 0
	for {
		if b.stopAsked(ctl, i) {
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
		if !b.ownHead(ctl, i, k, pr.HeadRefOid) {
			return b.voidItem(ctl, i, pr.HeadRefOid)
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
			if len(ci.Checks) > 0 {
				expected = ci.Checks
			}
			stop, out := b.rebase(ctl, i, pr)
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
			rebasedAt = b.env.Now()
			continue
		}
		computingSince = time.Time{}
		if failing := namesIn(ci.Checks, mission.ReviewCheckFailure); len(failing) > 0 {
			return b.stopItem(ctl, i, batchStop{reason: BatchReasonFailing, names: failing})
		}
		settled := b.env.Now().Sub(rebasedAt) >= b.env.ChecksSettle
		if ci.Pending > 0 || len(missingChecks(expected, ci.Checks, settled)) > 0 {
			b.setItem(ctl, i, func(it *BatchItem) { it.State = BatchItemWaitingChecks })
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
		out, stop := b.merge(ctl, i, k, pr)
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

// remaining: the queue's other PRs not merged or out of it; the cleanup after each merge leaves them to the queue.
func (b *BatchRunner) remaining(ctl *batchCtl, i int) []int {
	run := b.read(ctl)
	var rtn []int
	for j, it := range run.Items {
		if j != i && itemOpen(it.State) {
			rtn = append(rtn, it.Number)
		}
	}
	return rtn
}

// beginMerging: from here the PR can no longer be withdrawn; false when it was withdrawn first.
func (b *BatchRunner) beginMerging(ctl *batchCtl, i int) bool {
	b.pubLock.Lock()
	defer b.pubLock.Unlock()
	b.lock.Lock()
	if ctl.run.CancelAsked || ctl.withdrawn[ctl.run.Items[i].Number] || ctl.preempt {
		b.lock.Unlock()
		return false
	}
	ctl.run.Items[i].State = BatchItemMerging
	run := copyRun(ctl.run)
	current := b.runs[ctl.key] == ctl
	b.lock.Unlock()
	if current {
		b.publish(run)
	}
	return true
}

// covers: the developer confirmed every warning of the plan when they validated it.
func covers(confirmed []string, warnings []string) bool {
	for _, w := range warnings {
		found := false
		for _, c := range confirmed {
			if c == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// batchItemMethod is the method a queued PR merges with (#957): its own (the one shown when it joined), else the
// queue's, else the plan's default for a queue saved before #957. ok is false when GitHub no longer allows it: the PR
// stops rather than merge with a method the developer did not see.
func batchItemMethod(item BatchItem, run BatchRun, plan MergePlan) (string, bool) {
	method := item.Method
	if method == "" {
		method = run.Method
	}
	if method == "" {
		method = plan.Method
	}
	return method, hasMethod(plan.Methods, method)
}

// merge goes through Validate's path (FR-REV-012): a plan read fresh, then the merge bound to its head, with the
// method validated; its cleanup runs after it as after a manual merge.
func (b *BatchRunner) merge(ctl *batchCtl, i int, k PrKey, pr ghMergePr) (int, batchStop) {
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
		case blocking.Id == CheckIdBlocked && blocking.State == CheckFail:
			return batchStopped, batchStop{reason: BatchReasonBlocked}
		case blocking.Id == CheckIdOpen && blocking.Code == CheckCodeDraft:
			return batchStopped, batchStop{reason: BatchReasonDraft}
		}
		return batchAgain, batchStop{reason: BatchReasonMergeFailed, code: blocking.Code}
	}
	override := len(plan.Warnings) > 0 && covers(item.Overridden, plan.Warnings)
	if len(plan.Warnings) > 0 && !override {
		return batchStopped, batchStop{reason: BatchReasonWarnings, names: plan.Warnings}
	}
	method, ok := batchItemMethod(item, run, plan)
	if !ok {
		return batchStopped, batchStop{reason: BatchReasonMethod, names: []string{method}}
	}
	if !b.beginMerging(ctl, i) {
		return batchCancelled, batchStop{}
	}
	if _, err := m.Merge(MergeRequest{PrKey: k, PlanId: plan.Id, Override: override, Method: method, Batch: b.remaining(ctl, i)}); err != nil {
		return batchStopped, batchStop{reason: BatchReasonMergeFailed, detail: err.Error()}
	}
	final := b.waitMerge(ctl, k)
	if final.Updated {
		b.change(ctl, func(run *BatchRun) {
			run.Items[i].CiRuns++
			run.CiRuns++
			// GitHub's update of the branch is the queue's own push.
			if final.Head != "" && final.PlanHead == run.Items[i].Valid {
				run.Items[i].Valid = final.Head
			}
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
		b.setItem(ctl, i, func(it *BatchItem) { it.State = BatchItemChecking })
		return batchAgain, batchStop{reason: BatchReasonMergeFailed, code: final.Code}
	}
	switch final.Code {
	case MergeCodeCiFailed:
		return batchStopped, batchStop{reason: BatchReasonFailing, names: final.Names}
	case MergeCodeConflict:
		b.setItem(ctl, i, func(it *BatchItem) { it.State = BatchItemChecking })
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

// finish ends the queue: the PRs still in it are withdrawn (a cancel), the agent's terminal and worktree go when
// nothing would be lost, and a queue of several PRs sums up by notification.
func (b *BatchRunner) finish(ctl *batchCtl) {
	b.cleanAgent(ctl, ctl.agent)
	b.tryFinish(ctl)
	run := b.change(ctl, func(run *BatchRun) {
		for i := range run.Items {
			it := &run.Items[i]
			if batchItemEnded(it.State) {
				continue
			}
			it.State, it.Reason = BatchItemWithdrawn, BatchReasonCancelled
			it.Waiting = false
			if it.EndedAt == 0 {
				it.EndedAt = b.env.Now().UnixMilli()
			}
		}
		run.Current = -1
		run.EndedAt = b.env.Now().UnixMilli()
	})
	if len(run.Items) > 1 || run.State == BatchCancelled {
		b.notifyEnd(run)
	}
	log.Printf("%s queue %s: %s, %d CI runs redone\n", logPrefix, run.Id, run.State, run.CiRuns)
}
