// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The merge queue's notifications (FR-REV-025, FR-REV-026 AC8): each merge says when the PR was validated; each stop
// names its PR and its reason (a failing check offers Investigate and fix) and stays until the PR merged, came back
// or left; a push the queue did not make says the validation is void; the end of a queue of several PRs sums up what
// was merged, what was not and why, and how many CI runs the queue redid. Nothing opens by itself.

const (
	batchNoticePrefix = "review:batch:"
	// ReviewsViewName opens the Reviews list from a notification; must match MoltentermReviewsView.
	ReviewsViewName = "molten-reviews"
	// InvestigateGesture runs Investigate and fix on a PR from a notification; must match
	// frontend/moltenterm-shell/reviews/reviews-queue-gesture.ts.
	InvestigateGesture = "review:investigate"
)

func batchNoticeKey(dir string, what string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	return batchNoticePrefix + hex.EncodeToString(sum[:6]) + ":" + what
}

func (b *BatchRunner) notify(input molten.NotificationInput) {
	if b.env.Agents == nil || b.env.Agents.env.Notify == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	if err := b.env.Agents.env.Notify(ctx, input); err != nil {
		log.Printf("%s %s: the notification could not be published: %v\n", logPrefix, input.Key, err)
	}
}

func prNoticeKey(run BatchRun, number int) string {
	return batchNoticeKey(run.Dir, "pr:"+run.Base+":"+strconv.Itoa(number)+":")
}

// resolvePrNotice: a PR's "needs you" is over once it merged, came back or left the queue.
func (b *BatchRunner) resolvePrNotice(run BatchRun, number int) {
	if b.env.Agents == nil || b.env.Agents.env.ResolveNotices == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	key := prNoticeKey(run, number)
	if err := b.env.Agents.env.ResolveNotices(ctx, key); err != nil {
		log.Printf("%s %s: the notification could not be resolved: %v\n", logPrefix, key, err)
	}
}

func reviewsAction() molten.NotificationAction {
	return molten.NotificationAction{Id: "reviews", Label: "Open the Control room", LabelText: uimsg.Make("notif.review.batch.openReviews"),
		Kind: "open", View: ReviewsViewName}
}

func terminalAction(run BatchRun) molten.NotificationAction {
	return molten.NotificationAction{Id: "terminal", Label: "Go to the terminal", LabelText: uimsg.Make("notif.review.batch.goTo"),
		Kind: "open", WorkspaceId: run.WorkspaceId, TabId: run.TabId, BlockId: run.BlockId}
}

// batchReasonText words why a PR stopped or was skipped: English for the logs and the code for the windows.
func batchReasonText(it BatchItem, base string) (string, *uimsg.Text) {
	names := strings.Join(it.Names, ", ")
	switch it.Reason {
	case BatchReasonFailing:
		return "checks failing: " + names, uimsg.Make("notif.review.batch.why.failing", "names", names)
	case BatchReasonAmbiguous:
		if it.Note == "" {
			return "a conflict the agent left to you", uimsg.Make("notif.review.batch.why.ambiguous")
		}
		return "a conflict the agent left to you: " + it.Note, uimsg.Make("notif.review.batch.why.ambiguousNote", "note", it.Note)
	case BatchReasonConflict:
		return "still conflicts with " + base + " after a rebase", uimsg.Make("notif.review.batch.why.conflict", "base", base)
	case BatchReasonAgentExited:
		return "the agent's session ended before it pushed", uimsg.Make("notif.review.batch.why.agentexited")
	case BatchReasonAgentTimeout:
		return "the agent did not finish the rebase in time", uimsg.Make("notif.review.batch.why.agenttimeout")
	case BatchReasonNoAgent:
		return "no coding agent is installed for the rebase", uimsg.Make("notif.review.batch.why.noagent")
	case BatchReasonAgentMissing:
		return it.Detail + ", the coding agent you chose, is not installed", uimsg.Make("notif.review.batch.why.agentmissing", "detail", it.Detail)
	case BatchReasonAgentStart:
		return "the agent could not be started: " + it.Detail, uimsg.Make("notif.review.batch.why.agentstart", "detail", it.Detail)
	case BatchReasonBlocked:
		return "GitHub blocks the merge (a review or a rule)", uimsg.Make("notif.review.batch.why.blocked")
	case BatchReasonWarnings:
		return "unpublished comments or work in progress", uimsg.Make("notif.review.batch.why.warnings")
	case BatchReasonMethod:
		return "GitHub no longer allows the merge method shown (" + names + ")", uimsg.Make("notif.review.batch.why.method", "names", names)
	case BatchReasonCiTimeout:
		return "its checks did not finish in time", uimsg.Make("notif.review.batch.why.citimeout")
	case BatchReasonUnknown:
		return "GitHub did not say whether it merges cleanly", uimsg.Make("notif.review.batch.why.unknown")
	case BatchReasonMergeFailed:
		return "the merge failed: " + it.Detail + it.Code, uimsg.Make("notif.review.batch.why.mergefailed", "detail", it.Detail+it.Code)
	case BatchReasonRead:
		return "GitHub could not be read: " + it.Detail, uimsg.Make("notif.review.batch.why.read", "detail", it.Detail)
	case BatchReasonHeadMoved:
		return "its branch kept moving", uimsg.Make("notif.review.batch.why.headmoved")
	case BatchReasonDraft:
		return "it is a draft", uimsg.Make("notif.review.batch.why.draft")
	case BatchReasonMergedAway:
		return "already merged", uimsg.Make("notif.review.batch.why.mergedaway")
	case BatchReasonClosed:
		return "closed", uimsg.Make("notif.review.batch.why.closed")
	case BatchReasonCancelled:
		return "cancelled", uimsg.Make("notif.review.batch.why.cancelled")
	case BatchReasonInterrupted:
		return "MoltenTerm restarted", uimsg.Make("notif.review.batch.why.interrupted")
	case BatchReasonPushed:
		return "pushed after your validation", uimsg.Make("notif.review.batch.why.pushed")
	case BatchReasonWithdrawn:
		return "validation cancelled", uimsg.Make("notif.review.batch.why.withdrawn")
	}
	return "not reached", uimsg.Make("notif.review.batch.why.notreached")
}

// investigateAction: Investigate and fix (#896) on the PR whose checks failed, from the notification.
func investigateAction(run BatchRun, it BatchItem) molten.NotificationAction {
	return molten.NotificationAction{Id: "investigate", Label: "Analyze and resolve", LabelText: uimsg.Make("notif.review.queue.investigate"),
		Kind: "gesture", Gesture: InvestigateGesture, Lasting: true,
		Args: map[string]any{"dir": run.Dir, "repo": run.Repo, "number": it.Number}}
}

// notifyStop: one "needs you" per stop (FR-REV-026 AC4, AC8). A failing check names the checks and offers Investigate
// and fix; the PR stays watched on its head. Any other stop takes it out of the queue until a new validation.
func (b *BatchRunner) notifyStop(run BatchRun, i int) {
	it := run.Items[i]
	number := strconv.Itoa(it.Number)
	reason, reasonText := batchReasonText(it, run.Base)
	input := molten.NotificationInput{
		Key:         prNoticeKey(run, it.Number) + "stop:" + strconv.FormatInt(b.env.Now().UnixMilli(), 10),
		Source:      "agent",
		Kind:        "warning",
		Title:       "#" + number + " needs you: the merge queue stopped on it",
		TitleText:   uimsg.Make("notif.review.queue.stoppedTitle", "number", number),
		Message:     "Reason: " + reason + ". The other validated PRs go on; validate it again once it is sorted out.",
		MessageText: uimsg.Make("notif.review.queue.stopped").With("reason", reasonText),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if it.State == BatchItemFailed {
		names := strings.Join(it.Names, ", ")
		input.Kind = "error"
		input.Title = "#" + number + " validated but CI failed: " + names
		input.TitleText = uimsg.Make("notif.review.queue.failedTitle", "number", number, "names", names)
		input.Message = "It is not merged while a check fails. It merges once its checks pass on the same head; a new push needs a new validation."
		input.MessageText = uimsg.Make("notif.review.queue.failed")
		input.Actions = []molten.NotificationAction{investigateAction(run, it), reviewsAction()}
	} else if run.BlockId != "" && (it.Reason == BatchReasonAmbiguous || it.Reason == BatchReasonAgentExited || it.Reason == BatchReasonAgentTimeout) {
		input.TabId, input.BlockId = run.TabId, run.BlockId
		input.Actions = []molten.NotificationAction{terminalAction(run), reviewsAction()}
	}
	b.notify(input)
}

// notifyVoided: a push the queue did not make changed the validated code (FR-REV-026 AC5).
func (b *BatchRunner) notifyVoided(run BatchRun, i int) {
	it := run.Items[i]
	number := strconv.Itoa(it.Number)
	b.notify(molten.NotificationInput{
		Key:         prNoticeKey(run, it.Number) + "voided:" + strconv.FormatInt(b.env.Now().UnixMilli(), 10),
		Source:      "agent",
		Kind:        "warning",
		Title:       "#" + number + " changed after your validation",
		TitleText:   uimsg.Make("notif.review.queue.voidedTitle", "number", number),
		Message:     "Someone pushed " + shortHead(it.Head) + " on it: it left the merge queue and is back to review. Review the new commits and validate it again.",
		MessageText: uimsg.Make("notif.review.queue.voided", "head", shortHead(it.Head)),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	})
}

// notifyMerged: "#N merged (validated at HH:MM)" (FR-REV-026 AC8).
func (b *BatchRunner) notifyMerged(run BatchRun, i int) {
	it := run.Items[i]
	number := strconv.Itoa(it.Number)
	at := time.UnixMilli(it.ValidatedAt).Format("15:04")
	b.resolvePrNotice(run, it.Number)
	b.notify(molten.NotificationInput{
		Key:         prNoticeKey(run, it.Number) + "merged",
		Source:      "agent",
		Kind:        "success",
		Title:       "#" + number + " merged (validated at " + at + ")",
		TitleText:   uimsg.Make("notif.review.queue.mergedTitle", "number", number, "time", at),
		Message:     "The merge queue merged it into " + run.Base + ".",
		MessageText: uimsg.Make("notif.review.queue.merged", "base", run.Base),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	})
}

// notifyResumed: the queue says it resumed after a restart (FR-REV-026 AC2).
func (b *BatchRunner) notifyResumed(run BatchRun, count int) {
	if count == 0 {
		return
	}
	b.notify(molten.NotificationInput{
		Key:         batchNoticeKey(run.Dir, "resumed:"+run.Id+":"+strconv.FormatInt(run.ResumedAt, 10)),
		Source:      "agent",
		Kind:        "info",
		Title:       fmt.Sprintf("The merge queue of %s resumed: %d validated PRs", run.Base, count),
		TitleText:   uimsg.Make("notif.review.queue.resumedTitle", "base", run.Base, "count", strconv.Itoa(count)),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	})
}

// batchList chains the skipped PRs as parts, so the window words each reason: "#4 (checks failing: ci), #5 (not
// reached)".
func batchSkippedList(items []BatchItem, base string) (string, *uimsg.Text) {
	var english []string
	var text *uimsg.Text
	for i := len(items) - 1; i >= 0; i-- {
		reason, reasonText := batchReasonText(items[i], base)
		english = append([]string{"#" + strconv.Itoa(items[i].Number) + " (" + reason + ")"}, english...)
		number := strconv.Itoa(items[i].Number)
		node := uimsg.Make("notif.review.batch.skippedNext", "number", number)
		if i == 0 {
			node = uimsg.Make("notif.review.batch.skippedFirst", "number", number)
		}
		node.With("reason", reasonText)
		if text == nil {
			node.Vars["rest"] = ""
		} else {
			node.With("rest", text)
		}
		text = node
	}
	return "Skipped: " + strings.Join(english, ", ") + ". ", text
}

func keptText(kept string) *uimsg.Text {
	switch kept {
	case BatchKeptChanges:
		return uimsg.Make("notif.review.batch.kept.changes")
	case BatchKeptUnpushed:
		return uimsg.Make("notif.review.batch.kept.unpushed")
	case BatchKeptRebasing:
		return uimsg.Make("notif.review.batch.kept.rebasing")
	case BatchKeptWorking:
		return uimsg.Make("notif.review.batch.kept.working")
	case BatchKeptUnread:
		return uimsg.Make("notif.review.batch.kept.unread")
	}
	return nil
}

func numbersText(items []BatchItem) string {
	var parts []string
	for _, it := range items {
		parts = append(parts, "#"+strconv.Itoa(it.Number))
	}
	return strings.Join(parts, ", ")
}

// trunkUpdates sums the commits the cleanups after the batch's merges brought to the local trunk (#909).
func (b *BatchRunner) trunkUpdates(run BatchRun, merged []BatchItem) (string, int) {
	if b.env.Merger == nil || b.env.Merger.store == nil {
		return "", 0
	}
	branch, count := "", 0
	for _, it := range merged {
		state, err := b.env.Merger.store.Get(PrKey{Repo: run.Repo, Number: it.Number})
		if err != nil || state.Cleanup == nil {
			continue
		}
		step := state.Cleanup.Step(CleanupStepLocalTrunk)
		if step == nil || step.State != CleanupStateDone || step.Code != CleanupCodeTrunkUpdated {
			continue
		}
		branch = step.Branch
		count += step.Count
	}
	return branch, count
}

func (b *BatchRunner) notifyEnd(run BatchRun) {
	var merged, skipped []BatchItem
	for _, it := range run.Items {
		if it.State == BatchItemMerged {
			merged = append(merged, it)
		} else {
			skipped = append(skipped, it)
		}
	}
	total, count := strconv.Itoa(len(run.Items)), strconv.Itoa(len(merged))
	input := molten.NotificationInput{
		Key:         batchNoticeKey(run.Dir, "end:"+run.Id),
		Source:      "agent",
		Kind:        "success",
		Title:       fmt.Sprintf("Merge queue: %s of %s PRs merged", count, total),
		TitleText:   uimsg.Make("notif.review.batch.doneTitle", "merged", count, "total", total),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if run.State == BatchCancelled {
		input.Title = fmt.Sprintf("Merge queue cancelled: %s of %s PRs merged", count, total)
		input.TitleText = uimsg.Make("notif.review.batch.cancelledTitle", "merged", count, "total", total)
	}
	if len(skipped) > 0 {
		input.Kind = "warning"
	}
	message := uimsg.Make("notif.review.batch.summary", "ciruns", strconv.Itoa(run.CiRuns))
	english := ""
	if len(merged) > 0 {
		list := numbersText(merged)
		english += "Merged: " + list + ". "
		message.With("merged", uimsg.Make("notif.review.batch.mergedList", "list", list))
	} else {
		english += "Nothing merged. "
		message.With("merged", uimsg.Make("notif.review.batch.mergedNone"))
	}
	if len(skipped) > 0 {
		text, part := batchSkippedList(skipped, run.Base)
		english += text
		message.With("skipped", part)
	} else {
		message.Vars["skipped"] = ""
	}
	english += fmt.Sprintf("CI runs redone: %d.", run.CiRuns)
	if kept := keptText(run.Kept); kept != nil {
		english += " The agent's worktree is kept: " + run.Kept + "."
		message.With("kept", kept)
	} else {
		message.Vars["kept"] = ""
	}
	if branch, count := b.trunkUpdates(run, merged); count > 0 {
		english += fmt.Sprintf(" Local %s updated: +%d commits.", branch, count)
		part := uimsg.Make("notif.review.batch.trunkUpdated", "branch", branch, "count", strconv.Itoa(count))
		if count == 1 {
			english = strings.TrimSuffix(english, "commits.") + "commit."
			part = uimsg.Make("notif.review.batch.trunkUpdatedOne", "branch", branch)
		}
		message.With("trunk", part)
	} else {
		message.Vars["trunk"] = ""
	}
	input.Message, input.MessageText = english, message
	if run.BlockId != "" && run.Kept != "" {
		input.Actions = append([]molten.NotificationAction{terminalAction(run)}, input.Actions...)
	}
	b.notify(input)
}
