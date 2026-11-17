// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Brokk's card in his notes (FR-BOSS-012 AC8): a notification of the log watch's own source, already read when it
// arrives (no toast, no visit, nothing opens: No surprise in the UI), worded by the window in the developer's language.
// Its kind is never "warning", which asks the developer to answer and opens the panel, and its three actions have
// three gestures, so the card is no question either.

const (
	// NotificationSource must match the source in frontend/moltenterm-shell/notifications-model.ts.
	NotificationSource = "logwatch"
	// CardKeyPrefix + a signature's id (or GrowthId) is a card's key.
	CardKeyPrefix = "logwatch:"
	// The gestures of the card's actions; must match frontend/moltenterm-shell/logwatch/logwatch-gestures.ts.
	AskGesture    = "molten:logwatch:ask"
	MuteGesture   = "molten:logwatch:mute"
	RevealGesture = "path:reveal"

	// cardExcerptRunes: what a card quotes of the message; the brief has the whole excerpt.
	cardExcerptRunes = 110
	cardFrameRunes   = 80
)

// cardFacts is what a card needs besides the signature: where the log is, the clock and the zone of its stamps.
type cardFacts struct {
	logPath string
	now     time.Time
	loc     *time.Location
}

func titleOf(sig Signature) (string, *uimsg.Text) {
	if sig.Event == EventSpike {
		switch sig.Kind {
		case KindPanic:
			return "A panic keeps coming back", uimsg.Make("logwatch.title.spikePanic")
		case KindCrash:
			return "A crash keeps coming back", uimsg.Make("logwatch.title.spikeCrash")
		case KindWarning:
			return "A warning keeps coming back", uimsg.Make("logwatch.title.spikeWarning")
		}
		return "An error keeps coming back", uimsg.Make("logwatch.title.spikeError")
	}
	if sig.Kind == KindCrash {
		return "A crash in the log", uimsg.Make("logwatch.title.newCrash")
	}
	return "A new panic in the log", uimsg.Make("logwatch.title.newPanic")
}

func timesOf(count int64) (string, *uimsg.Text) {
	if count == 1 {
		return "once", uimsg.Make("logwatch.times.one")
	}
	n := strconv.FormatInt(count, 10)
	return n + " times", uimsg.Make("logwatch.times.other", "count", n)
}

// sinceOf is when a signature was first seen: its time on the same day, else its date and time.
func sinceOf(ms int64, now time.Time, loc *time.Location) string {
	at := time.UnixMilli(ms).In(loc)
	today := now.In(loc)
	if at.Year() == today.Year() && at.YearDay() == today.YearDay() {
		return at.Format("15:04")
	}
	return at.Format("2006-01-02 15:04")
}

// cardQuote is a line as a card quotes it inline: one line, no backticks (they would end the inline code), bounded.
func cardQuote(text string, max int) string {
	first, _, _ := strings.Cut(text, "\n")
	first = strings.ReplaceAll(strings.TrimSpace(first), "`", "'")
	return cutRunes(strings.Join(strings.Fields(first), " "), max)
}

func sizeOf(bytes int64) (string, *uimsg.Text) {
	mb := strconv.FormatInt((bytes+(1<<19))>>20, 10)
	return mb + " MB", uimsg.Make("logwatch.size", "mb", mb)
}

// withAsked puts who looks first, once the developer asked an agent.
func withAsked(asked string, english string, text *uimsg.Text) (string, *uimsg.Text) {
	if asked == "" {
		return english, text
	}
	return asked + " is having a look. " + english, uimsg.Make("logwatch.message.asked", "name", asked).With("rest", text)
}

func cardActions(id string, logPath string) []molten.NotificationAction {
	return []molten.NotificationAction{
		{Id: "ask", Label: "Ask an agent to look", LabelText: uimsg.Make("logwatch.action.ask"), Kind: "gesture",
			Gesture: AskGesture, Args: map[string]any{"id": id}},
		{Id: "mute", Label: "Ignore this kind", LabelText: uimsg.Make("logwatch.action.mute"), Kind: "gesture",
			Gesture: MuteGesture, Args: map[string]any{"id": id}},
		{Id: "reveal", Label: "Show in folder", LabelText: uimsg.Make("logwatch.action.reveal"), Kind: "gesture",
			Gesture: RevealGesture, Args: map[string]any{"path": logPath}, Lasting: true},
	}
}

// signatureCard is the card of a signature, raised (refresh false) or brought up to date while open (refresh true).
func signatureCard(sig Signature, f cardFacts, refresh bool) molten.NotificationInput {
	title, titleText := titleOf(sig)
	times, timesText := timesOf(sig.Count)
	since := sinceOf(sig.First, f.now, f.loc)
	excerpt := cardQuote(sig.Excerpt, cardExcerptRunes)
	frame := ""
	if len(sig.Frames) > 0 {
		frame = cardQuote(sig.Frames[0], cardFrameRunes)
	}
	var message string
	var messageText *uimsg.Text
	if sig.Event == EventSpike {
		rate := strconv.FormatInt(rateOf(sig), 10)
		message = fmt.Sprintf("About %s a minute lately, %s since %s: `%s`", rate, times, since, excerpt)
		messageText = uimsg.Make("logwatch.message.spike", "rate", rate, "since", since, "excerpt", excerpt)
		if frame != "" {
			message += fmt.Sprintf(" in `%s`", frame)
			messageText = uimsg.Make("logwatch.message.spikeAt", "rate", rate, "since", since, "excerpt", excerpt, "frame", frame)
		}
	} else {
		message = fmt.Sprintf("I spotted it %s since %s: `%s`", times, since, excerpt)
		messageText = uimsg.Make("logwatch.message.new", "since", since, "excerpt", excerpt)
		if frame != "" {
			message += fmt.Sprintf(" in `%s`", frame)
			messageText = uimsg.Make("logwatch.message.newAt", "since", since, "excerpt", excerpt, "frame", frame)
		}
	}
	messageText.With("times", timesText)
	message, messageText = withAsked(sig.Asked, message, messageText)
	kind := "info"
	if raisesNew(sig.Kind) {
		kind = "error"
	}
	return molten.NotificationInput{
		Key:         CardKeyPrefix + sig.Id,
		Source:      NotificationSource,
		Kind:        kind,
		Title:       title,
		TitleText:   titleText,
		Message:     message,
		MessageText: messageText,
		Actions:     cardActions(sig.Id, f.logPath),
		Quiet:       true,
		RefreshOnly: refresh,
	}
}

// growthCard is the card of a log that grows too fast.
func growthCard(g growthMark, f cardFacts, refresh bool) molten.NotificationInput {
	size, sizeText := sizeOf(g.Bytes)
	message := size + " written in the last hour: something may be repeating."
	messageText := uimsg.Make("logwatch.message.growth").With("size", sizeText)
	message, messageText = withAsked(g.Asked, message, messageText)
	return molten.NotificationInput{
		Key:         CardKeyPrefix + GrowthId,
		Source:      NotificationSource,
		Kind:        "info",
		Title:       "The log grows fast",
		TitleText:   uimsg.Make("logwatch.title.growth"),
		Message:     message,
		MessageText: messageText,
		Actions:     cardActions(GrowthId, f.logPath),
		Quiet:       true,
		RefreshOnly: refresh,
	}
}
