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

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The batch's notifications (FR-REV-025 AC-5, AC-7, AC-8): a stop names its PR and its reason and waits in the
// notification center until the developer decided; the end sums up what was merged, what was skipped and why, and how
// many CI runs the batch redid. Both reach the agent's terminal when there is one; nothing opens by itself.

const (
	batchNoticePrefix = "review:batch:"
	// ReviewsViewName opens the Reviews list from a notification; must match MoltentermReviewsView.
	ReviewsViewName = "molten-reviews"
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

func (b *BatchRunner) resolveStopNotice(ctl *batchCtl) {
	if b.env.Agents == nil || b.env.Agents.env.ResolveNotices == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	key := batchNoticeKey(b.read(ctl).Dir, "stop:")
	if err := b.env.Agents.env.ResolveNotices(ctx, key); err != nil {
		log.Printf("%s %s: the notification could not be resolved: %v\n", logPrefix, key, err)
	}
}

func reviewsAction() molten.NotificationAction {
	return molten.NotificationAction{Id: "reviews", Label: "Open the Reviews list", LabelText: uimsg.Make("notif.review.batch.openReviews"),
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
	case BatchReasonAgentStart:
		return "the agent could not be started: " + it.Detail, uimsg.Make("notif.review.batch.why.agentstart", "detail", it.Detail)
	case BatchReasonBlocked:
		return "GitHub blocks the merge (a review or a rule)", uimsg.Make("notif.review.batch.why.blocked")
	case BatchReasonWarnings:
		return "unpublished comments or work in progress", uimsg.Make("notif.review.batch.why.warnings")
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
	}
	return "not reached", uimsg.Make("notif.review.batch.why.notreached")
}

func (b *BatchRunner) notifyStop(ctl *batchCtl, run BatchRun, i int) {
	it := run.Items[i]
	number := strconv.Itoa(it.Number)
	reason, reasonText := batchReasonText(it, run.Base)
	input := molten.NotificationInput{
		Key:         batchNoticeKey(run.Dir, "stop:"+run.Id+":"+number),
		Source:      "agent",
		Kind:        "warning",
		Title:       "The batch merge stopped on #" + number,
		TitleText:   uimsg.Make("notif.review.batch.stoppedTitle", "number", number),
		Message:     "Reason: " + reason + ". The PRs after it wait for your decision in the Reviews list.",
		MessageText: uimsg.Make("notif.review.batch.stopped").With("reason", reasonText),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if run.BlockId != "" {
		input.TabId, input.BlockId = run.TabId, run.BlockId
	}
	b.notify(input)
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
		Title:       fmt.Sprintf("Batch merge: %s of %s PRs merged", count, total),
		TitleText:   uimsg.Make("notif.review.batch.doneTitle", "merged", count, "total", total),
		WorkspaceId: run.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if run.State == BatchCancelled {
		input.Title = fmt.Sprintf("Batch merge cancelled: %s of %s PRs merged", count, total)
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
	input.Message, input.MessageText = english, message
	if run.BlockId != "" && run.Kept != "" {
		input.Actions = append([]molten.NotificationAction{terminalAction(run)}, input.Actions...)
	}
	b.notify(input)
}
