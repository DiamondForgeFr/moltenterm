// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const (
	// ReviewsCardGesture opens the Control room on a PR's card from a notification; must match
	// frontend/moltenterm-shell/reviews/reviews-card-gesture.ts.
	ReviewsCardGesture = "reviews:card"
	// ReviewsCardActionId: the action a click on the notification itself runs (notifications-store.ts).
	ReviewsCardActionId = "card"
)

// PrCard is how a notification names a PR (#1130, FR-REV-001 AC2): by the number its Control room card shows (#1108:
// its ticket, else its PR number), with the PR number after it when the two differ.
type PrCard struct {
	Shown int
	Pr    int
}

func MakePrCard(pr int, ticket int) PrCard {
	if ticket > 0 {
		return PrCard{Shown: ticket, Pr: pr}
	}
	return PrCard{Shown: pr, Pr: pr}
}

// Number is the card's number, for a {number} placeholder.
func (c PrCard) Number() string {
	return strconv.Itoa(c.Shown)
}

// English names the PR as a title does: "#1107 (PR #1120)", or "#1120" with no other ticket.
func (c PrCard) English() string {
	if c.Shown == c.Pr {
		return "#" + c.Number()
	}
	return "#" + c.Number() + " (PR #" + strconv.Itoa(c.Pr) + ")"
}

// Aside fills the {pr} placeholder of a title that names the PR as "#{number}{pr}".
func (c PrCard) Aside(text *uimsg.Text) *uimsg.Text {
	if c.Shown == c.Pr {
		if text.Vars == nil {
			text.Vars = make(map[string]string)
		}
		text.Vars["pr"] = ""
		return text
	}
	return text.With("pr", uimsg.Make("notif.review.prAside", "number", strconv.Itoa(c.Pr)))
}

// Action shows the PR's card in the Control room; a click on the notification runs it too.
func (c PrCard) Action(dir string) molten.NotificationAction {
	return molten.NotificationAction{Id: ReviewsCardActionId, Label: "Show in Integration", LabelText: uimsg.Make("notif.review.openCard"),
		Kind: "gesture", Gesture: ReviewsCardGesture, Lasting: true, Args: map[string]any{"dir": dir, "number": c.Pr}}
}
