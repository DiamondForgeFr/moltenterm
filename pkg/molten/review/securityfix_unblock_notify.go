// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The one summary notification after a security fix merged (FR-REV-036 AC13, AC15): what the step after the merge did with
// each pull request the fix unblocked, grouped by outcome, in the order of what matters least to what needs the developer
// last. A pull request that merged or closed meanwhile is not told.

// unblockGroup is the pull requests that had the same outcome, and the agent that has them when the outcome is an agent's.
type unblockGroup struct {
	outcome string
	agent   string
	prs     []int
}

// unblockOrder is the order the sentences come in.
var unblockOrder = []string{secfix.UnblockUpdated, secfix.UnblockRerun, secfix.UnblockHanded, secfix.UnblockQueued, secfix.UnblockWaits,
	secfix.UnblockConflicts, secfix.UnblockFailed, secfix.UnblockLeft}

func unblockGroups(items []secfix.Unblocked) []unblockGroup {
	var groups []unblockGroup
	for _, outcome := range unblockOrder {
		start := len(groups)
		for _, item := range items {
			if item.Outcome != outcome {
				continue
			}
			agent := ""
			if outcome == secfix.UnblockHanded || outcome == secfix.UnblockQueued {
				agent = item.Agent
			}
			found := false
			for i := start; i < len(groups); i++ {
				if groups[i].agent == agent {
					groups[i].prs = append(groups[i].prs, item.Pr)
					found = true
					break
				}
			}
			if !found {
				groups = append(groups, unblockGroup{outcome: outcome, agent: agent, prs: []int{item.Pr}})
			}
		}
	}
	return groups
}

// unblockSentence is a group in English, and its text for the window to word.
func unblockSentence(g unblockGroup, trunk string) (string, *uimsg.Text) {
	prs := prNames(g.prs)
	switch g.outcome {
	case secfix.UnblockUpdated:
		return fmt.Sprintf("Updated onto %s, checks running again: %s.", trunk, prs),
			uimsg.Make("notif.secfix.unblock.updated", "trunk", trunk, "prs", prs)
	case secfix.UnblockRerun:
		return fmt.Sprintf("Already holding the fix, failed checks run again: %s.", prs),
			uimsg.Make("notif.secfix.unblock.rerun", "prs", prs)
	case secfix.UnblockHanded:
		return fmt.Sprintf("Rebase handed to %s, who works on it: %s.", g.agent, prs),
			uimsg.Make("notif.secfix.unblock.handed", "name", g.agent, "prs", prs)
	case secfix.UnblockQueued:
		return fmt.Sprintf("Rebase waits for %s to finish the task in hand: %s.", g.agent, prs),
			uimsg.Make("notif.secfix.unblock.queued", "name", g.agent, "prs", prs)
	case secfix.UnblockWaits:
		return fmt.Sprintf("Left alone, someone is working on it: %s.", prs),
			uimsg.Make("notif.secfix.unblock.waits", "prs", prs)
	case secfix.UnblockConflicts:
		return fmt.Sprintf("Conflicts with %s, ask for a rebase from its card: %s.", trunk, prs),
			uimsg.Make("notif.secfix.unblock.conflicts", "trunk", trunk, "prs", prs)
	case secfix.UnblockFailed:
		return fmt.Sprintf("Could not be brought back, see its card: %s.", prs),
			uimsg.Make("notif.secfix.unblock.failed", "prs", prs)
	}
	return fmt.Sprintf("Left alone, none of its checks fails: %s.", prs),
		uimsg.Make("notif.secfix.unblock.left", "prs", prs)
}

// chainTexts words several sentences one after the other: each is a placeholder of the one before.
func chainTexts(texts []*uimsg.Text) *uimsg.Text {
	if len(texts) == 1 {
		return texts[0]
	}
	return uimsg.Make("notif.secfix.unblock.then").With("first", texts[0]).With("second", chainTexts(texts[1:]))
}

// securityMergedUnblocked is the summary of a merged fix whose step after the merge dealt with pull requests; false when
// there is nothing to say of them (none, or only ones that went away).
func securityMergedUnblocked(fix secfix.Fix) (molten.NotificationInput, bool) {
	groups := unblockGroups(fix.Unblocked)
	if len(groups) == 0 {
		return molten.NotificationInput{}, false
	}
	var english []string
	var texts []*uimsg.Text
	for _, g := range groups {
		sentence, text := unblockSentence(g, fix.Trunk)
		english, texts = append(english, sentence), append(texts, text)
	}
	acted := 0
	needsYou := false
	for _, item := range fix.Unblocked {
		if item.Acted() {
			acted++
		}
		needsYou = needsYou || item.Outcome == secfix.UnblockConflicts || item.Outcome == secfix.UnblockFailed
	}
	pr := strconv.Itoa(fix.Pr)
	input := molten.NotificationInput{
		Key:         securityNoticeKey(fix.Dir, fix.Fingerprint, securityNoticeMerged),
		Source:      securityNoticeSource,
		Kind:        "success",
		Title:       "Security fix #" + pr + " merged",
		TitleText:   uimsg.Make("notif.secfix.mergedTitle", "pr", pr),
		Message:     strings.Join(english, " "),
		MessageText: chainTexts(texts),
		WorkspaceId: fix.WorkspaceId,
		Actions:     []molten.NotificationAction{reviewsAction()},
	}
	if acted > 0 {
		count := strconv.Itoa(acted)
		input.Title = fmt.Sprintf("Security fix #%s merged, %s pull request(s) unblocked", pr, count)
		input.TitleText = uimsg.Make("notif.secfix.mergedUnblockedTitle", "pr", pr, "count", count)
	}
	if needsYou {
		input.Kind = "warning"
	}
	return input, true
}
