// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"log"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Never silent (FR-REV-036 AC13): each step of the fix is a notification under the source "deps", whose subject is
// "dependencies": started (View in Integration, Stop), needs you, ready ("Merging #N unblocks #A, #B") and merged. The
// numbers of the pull requests are PR numbers, as GitHub and the Validate sheet name them. A step's notification is
// resolved when the step is over, and Brokk's visit model reads the open ones (frontend brokk-extra-feeds.ts) to raise its
// existing security event once per fix.

// The kinds of notification of a fix; a kind is the part of its key that tells it from the others of the same fix.
const (
	securityNoticeStarted = "started"
	securityNoticeNeeds   = "needs"
	securityNoticeReady   = "ready"
	securityNoticeMerged  = "merged"
)

// securityNoticeKey: molten:secfix:<kind>:<project>:<fingerprint>:, resolved by its prefix.
func securityNoticeKey(dir string, fingerprint string, kind string) string {
	return securityNoticePrefix + kind + ":" + strings.ToLower(dir) + ":" + fingerprint + ":"
}

func idsLine(fix secfix.Fix) string {
	return strings.Join(shownIds(fix.Ids), ", ")
}

func prNames(numbers []int) string {
	names := make([]string, 0, len(numbers))
	for _, n := range numbers {
		names = append(names, "#"+strconv.Itoa(n))
	}
	return strings.Join(names, ", ")
}

func securityStopAction(fix secfix.Fix) molten.NotificationAction {
	return molten.NotificationAction{Id: "stop", Label: "Stop", LabelText: uimsg.Make("notif.secfix.stop"), Kind: "gesture",
		Gesture: SecurityFixStopGesture, Args: map[string]any{"dir": fix.Dir, "fingerprint": fix.Fingerprint}}
}

func securityTerminalAction(fix secfix.Fix) molten.NotificationAction {
	return molten.NotificationAction{Id: "terminal", Label: "Go to the terminal", LabelText: uimsg.Make("notif.review.batch.goTo"),
		Kind: "open", WorkspaceId: fix.WorkspaceId, TabId: fix.TabId, BlockId: fix.BlockId}
}

func securityName(fix secfix.Fix) string {
	if fix.AgentName != "" {
		return fix.AgentName
	}
	return "The agent"
}

// securityStarted: the agent started in the background, with the way to see it and to stop it.
func securityStarted(fix secfix.Fix, auto bool) molten.NotificationInput {
	ticket := strconv.Itoa(fix.Ticket)
	input := molten.NotificationInput{
		Key:         securityNoticeKey(fix.Dir, fix.Fingerprint, securityNoticeStarted),
		Source:      securityNoticeSource,
		Kind:        "info",
		Title:       securityName(fix) + " started the security fix #" + ticket,
		TitleText:   uimsg.Make("notif.secfix.startedTitle", "name", securityName(fix), "ticket", ticket),
		Message:     "One ticket and one agent for " + idsLine(fix) + ": it works in the background and never merges. You can stop it.",
		MessageText: uimsg.Make("notif.secfix.started", "advisories", idsLine(fix)),
		WorkspaceId: fix.WorkspaceId,
		TabId:       fix.TabId,
		BlockId:     fix.BlockId,
		Actions:     []molten.NotificationAction{reviewsAction(), securityTerminalAction(fix), securityStopAction(fix)},
	}
	if auto {
		input.Message = "Started on its own, with your consent: " + input.Message
		input.MessageText = uimsg.Make("notif.secfix.startedAuto", "advisories", idsLine(fix))
	}
	return input
}

// securityNeedsYou: the fix waits for the developer; detail is why, in the agent's or MoltenTerm's own words.
func securityNeedsYou(fix secfix.Fix, detail string) molten.NotificationInput {
	detail = secfix.CleanLine(detail, outcomeMaxLength)
	title, titleText := "The security fix needs you", uimsg.Make("notif.secfix.needsTitleNoTicket")
	if fix.Ticket > 0 {
		ticket := strconv.Itoa(fix.Ticket)
		title = securityName(fix) + " needs you on the security fix #" + ticket
		titleText = uimsg.Make("notif.secfix.needsTitle", "name", securityName(fix), "ticket", ticket)
	}
	input := molten.NotificationInput{
		Key:         securityNoticeKey(fix.Dir, fix.Fingerprint, securityNoticeNeeds),
		Source:      securityNoticeSource,
		Kind:        "warning",
		Title:       title,
		TitleText:   titleText,
		Message:     detail,
		MessageText: securityReasonText(fix.Reason, detail),
		WorkspaceId: fix.WorkspaceId,
		TabId:       fix.TabId,
		BlockId:     fix.BlockId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if fix.BlockId != "" {
		input.Actions = append([]molten.NotificationAction{securityTerminalAction(fix)}, input.Actions...)
	}
	return input
}

// securityReasonText words why the fix needs the developer: MoltenTerm's reason by its code, or the agent's own line.
func securityReasonText(reason string, detail string) *uimsg.Text {
	// Each reason has its sentence in notif.secfix.why; the detail is MoltenTerm's own English line or a tool's.
	switch reason {
	case secfix.ReasonNoAgent:
		return uimsg.Make("notif.secfix.why.noagent", "detail", detail)
	case secfix.ReasonNoWorkspace:
		return uimsg.Make("notif.secfix.why.noworkspace", "detail", detail)
	case secfix.ReasonLaunchFailed:
		return uimsg.Make("notif.secfix.why.launchfailed", "detail", detail)
	case secfix.ReasonNoPr:
		return uimsg.Make("notif.secfix.why.nopr", "detail", detail)
	case secfix.ReasonChecksFailed:
		return uimsg.Make("notif.secfix.why.checksfailed", "detail", detail)
	case secfix.ReasonAgentGone:
		return uimsg.Make("notif.secfix.why.agentgone", "detail", detail)
	case secfix.ReasonPrClosed:
		return uimsg.Make("notif.secfix.why.prclosed", "detail", detail)
	case secfix.ReasonNotReady:
		return uimsg.Make("notif.secfix.why.notready", "detail", detail)
	case secfix.ReasonNewAdvisory:
		return uimsg.Make("notif.secfix.why.newadvisory", "detail", detail)
	}
	return uimsg.Make("notif.secfix.why.outcome", "reason", detail)
}

// securityReady: the fix's pull request is ready; merging it unblocks the others.
func securityReady(fix secfix.Fix, unblocks []int) molten.NotificationInput {
	pr := strconv.Itoa(fix.Pr)
	input := molten.NotificationInput{
		Key:         securityNoticeKey(fix.Dir, fix.Fingerprint, securityNoticeReady),
		Source:      securityNoticeSource,
		Kind:        "success",
		Title:       "Security fix #" + pr + " is ready to merge",
		TitleText:   uimsg.Make("notif.secfix.readyTitle", "pr", pr),
		Message:     "Its checks are green. Merging it is yours: MoltenTerm never merges.",
		MessageText: uimsg.Make("notif.secfix.ready"),
		WorkspaceId: fix.WorkspaceId,
		Actions:     []molten.NotificationAction{mission.MakePrCard(fix.Pr, 0).Action(fix.Dir)},
	}
	if len(unblocks) > 0 {
		names := prNames(unblocks)
		input.Title = "Merging #" + pr + " unblocks " + names
		input.TitleText = uimsg.Make("notif.secfix.readyUnblocksTitle", "pr", pr, "prs", names)
	}
	return input
}

// securityMerged: the fix landed. This is the one summary notification after the merge (FR-REV-036 AC13, AC15): when the
// step after the merge brought blocked pull requests back, it says what became of each; otherwise it only says the merge
// and which pull requests can resume.
func securityMerged(fix secfix.Fix, unblocks []int) molten.NotificationInput {
	if input, ok := securityMergedUnblocked(fix); ok {
		return input
	}
	pr := strconv.Itoa(fix.Pr)
	input := molten.NotificationInput{
		Key:         securityNoticeKey(fix.Dir, fix.Fingerprint, securityNoticeMerged),
		Source:      securityNoticeSource,
		Kind:        "success",
		Title:       "Security fix #" + pr + " merged",
		TitleText:   uimsg.Make("notif.secfix.mergedTitle", "pr", pr),
		Message:     "The advisories " + idsLine(fix) + " are fixed on " + fix.Trunk + ".",
		MessageText: uimsg.Make("notif.secfix.merged", "advisories", idsLine(fix), "trunk", fix.Trunk),
		WorkspaceId: fix.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if len(unblocks) > 0 {
		names := prNames(unblocks)
		input.Message += " " + names + " can resume."
		input.MessageText = uimsg.Make("notif.secfix.mergedUnblocks", "advisories", idsLine(fix), "trunk", fix.Trunk, "prs", names)
	}
	return input
}

// resolveSecurityNotice: the step's notification is over (the agent works again, the fix merged, it was stopped).
func (r *Restarter) resolveSecurityNotice(ctx context.Context, fix secfix.Fix, kinds ...string) {
	if r.env.ResolveNotices == nil {
		return
	}
	for _, kind := range kinds {
		if err := r.env.ResolveNotices(ctx, securityNoticeKey(fix.Dir, fix.Fingerprint, kind)); err != nil {
			log.Printf("%s security fix %s: the notification could not be resolved: %v\n", logPrefix, fix.Fingerprint, err)
		}
	}
}
