// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

func checkCardAction(t *testing.T, note molten.NotificationInput, dir string, number int) {
	t.Helper()
	for _, a := range note.Actions {
		if a.Id != mission.ReviewsCardActionId {
			continue
		}
		if a.Gesture != mission.ReviewsCardGesture || a.Args["dir"] != dir || a.Args["number"] != number || a.LabelText.Code != "notif.review.openCard" {
			t.Errorf("the card action opens the PR's card: %+v", a)
		}
		return
	}
	t.Errorf("no card action: %+v", note.Actions)
}

// #1130: an agent's notification names the PR by its card's number, the PR number after it when they differ, and a
// click on it opens that card.
func TestAgentNotificationsNameTheCard(t *testing.T) {
	f, follow, st, _ := investigateFollow(t)
	follow.req.Ticket = 1107
	f.r.ciGreen(context.Background(), follow, "Bruno", "")
	f.r.needsYou(context.Background(), follow, st, "Bruno", "stuck", uimsg.Make("notif.review.asks", "reason", "stuck"))
	if len(f.notes) != 2 {
		t.Fatalf("notes %+v", f.notes)
	}
	green, needs := f.notes[0], f.notes[1]
	aside := green.TitleText.Parts["pr"]
	if green.Title != "#1107 (PR #9): CI green again" || green.TitleText.Vars["number"] != "1107" ||
		aside == nil || aside.Code != "notif.review.prAside" || aside.Vars["number"] != "9" || green.MessageText.Vars["number"] != "1107" {
		t.Fatalf("CI green: %+v %+v", green, green.TitleText)
	}
	if needs.Title != "Bruno needs you on #1107 (PR #9)" || needs.TitleText.Vars["number"] != "1107" || needs.TitleText.Parts["pr"] == nil {
		t.Fatalf("needs you: %+v", needs)
	}
	for _, note := range f.notes {
		checkCardAction(t, note, f.dir, 9)
	}

	follow.req.Ticket, follow.req.HeadRef = 0, "spike"
	f.r.ciGreen(context.Background(), follow, "Bruno", "")
	plain := f.notes[2]
	if plain.Title != "#9: CI green again" || plain.TitleText.Vars["number"] != "9" || plain.TitleText.Parts["pr"] != nil {
		t.Fatalf("no ticket: the PR number alone: %+v %+v", plain, plain.TitleText)
	}
	if pr, ok := plain.TitleText.Vars["pr"]; !ok || pr != "" {
		t.Fatalf("no ticket: {pr} is empty: %+v", plain.TitleText)
	}
}

// #1130: the merge queue's notifications name each PR by its card's number.
func TestQueueNotificationsNameTheCard(t *testing.T) {
	var notes []molten.NotificationInput
	b := &BatchRunner{env: BatchEnv{Now: time.Now, Agents: &Restarter{env: RestartEnv{Notify: func(ctx context.Context, input molten.NotificationInput) error {
		notes = append(notes, input)
		return nil
	}}}}}
	run := BatchRun{Dir: "/p/app", Repo: "acme/app", Base: "develop", WorkspaceId: "ws-1", Items: []BatchItem{
		{BatchPr: BatchPr{Number: 1120, Ticket: 1107}, State: BatchItemSkipped, Reason: BatchReasonConflict},
		{BatchPr: BatchPr{Number: 1121}, State: BatchItemMerged},
	}}
	b.notifyStop(run, 0)
	b.notifyMerged(run, 1)
	if len(notes) != 2 {
		t.Fatalf("notes %+v", notes)
	}
	stop, merged := notes[0], notes[1]
	if stop.Title != "#1107 (PR #1120) needs you: the merge queue stopped on it" || stop.TitleText.Vars["number"] != "1107" ||
		stop.TitleText.Parts["pr"].Vars["number"] != "1120" {
		t.Fatalf("stop: %+v", stop)
	}
	checkCardAction(t, stop, "/p/app", 1120)
	if merged.Title[:6] != "#1121 " || merged.TitleText.Vars["number"] != "1121" || merged.TitleText.Parts["pr"] != nil {
		t.Fatalf("merged: %+v", merged)
	}
	checkCardAction(t, merged, "/p/app", 1121)
	if english, _ := batchSkippedList(run.Items[:1], run.Base); english != "Skipped: #1107 (still conflicts with develop after a rebase). " {
		t.Fatalf("summary: %q", english)
	}
}
