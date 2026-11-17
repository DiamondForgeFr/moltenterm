// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"fmt"
	"strconv"
	"strings"
)

// His model is never sent a digit: the window discards a line that has one (brokk-colleague.ts validModelLine), so a model
// that copied "14:05" or "125 minutes" would spend one of the day's few calls for nothing. The prompt tells a time, a
// stretch and a count in words instead.

const manyWord = "many"

var numberWords = [...]string{
	"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
	"thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one",
	"twenty-two", "twenty-three", "twenty-four",
}

func numberInWords(n int) string {
	if n < 0 || n >= len(numberWords) {
		return manyWord
	}
	return numberWords[n]
}

// partOfDay is the clock ("HH:MM", validated by validRequest) as a part of the day. The evening runs from 17:00 and the
// late evening from 21:00, where the hand-over's evening begins (brokk-colleague.ts EveningFromHour).
func partOfDay(clock string) string {
	if len(clock) < 2 {
		return "the day"
	}
	hour, err := strconv.Atoi(clock[:2])
	if err != nil {
		return "the day"
	}
	switch {
	case hour < 5:
		return "late night"
	case hour < 7:
		return "early morning"
	case hour < 10:
		return "morning"
	case hour < 12:
		return "late morning"
	case hour < 14:
		return "midday"
	case hour < 17:
		return "afternoon"
	case hour < 21:
		return "evening"
	}
	return "late evening"
}

// stretchInWords rounds a stretch to the nearest half hour, as a person would say it.
func stretchInWords(minutes int) string {
	halves := (minutes + 15) / 30
	switch {
	case halves <= 0:
		return "a few minutes"
	case halves == 1:
		return "about half an hour"
	case halves == 2:
		return "about an hour"
	case halves == 3:
		return "about an hour and a half"
	case halves%2 == 0:
		return fmt.Sprintf("about %s hours", numberInWords(halves/2))
	}
	return fmt.Sprintf("about %s and a half hours", numberInWords(halves/2))
}

// handoverMoment tells one agent as one: "1 coding agents" read as a mistake in the line his model wrote.
func handoverMoment(clock string, agents int) string {
	subject, own, them, finish := "some coding agents are", "their", "them", "what they finish"
	switch {
	case agents == 1:
		subject, own, them, finish = "one coding agent is", "its", "it", "what it finishes"
	case agents > 1:
		subject = numberInWords(agents) + " coding agents are"
	}
	return fmt.Sprintf("The time of day on the developer's clock is %s and %s still working on %s own. Say that you keep an eye on %s while the application is open, that %s will wait in the notifications, and that the developer can rest. Promise nothing else: you do not wake the developer, send a message or start any work at night.", partOfDay(clock), subject, own, them, finish)
}

func isFrench(code string) bool {
	lower := strings.ToLower(code)
	return lower == "fr" || strings.HasPrefix(lower, "fr-")
}

// promptRules are the hard rules of the line. The hand-over alone is told to say that the results wait in the
// notifications, so it alone is not forbidden to mention them. The window writes every line of a French interface with
// vous and never gives the developer a gender, so the model is held to the same register.
func promptRules(req PhraseRequest) string {
	forbidden := "a notification, a ticket, a pull request, a file, code or a name"
	if req.Kind == KindHandover {
		forbidden = "a ticket, a pull request, a file, code or a name"
	}
	rules := []string{
		"One line of plain text, at most 100 characters.",
		"No markdown, no list, no quotation marks, no emoji, no link.",
		"No digit: write any number in words, or leave it out.",
		fmt.Sprintf("Never mention %s.", forbidden),
	}
	if isFrench(req.Language) {
		rules = append(rules, "In French, address the developer as vous, never tu, and use no adjective or past participle that gives the developer a gender.")
	}
	rules = append(rules, "Use no tool. Output the line alone, nothing before or after it.")
	return "- " + strings.Join(rules, "\n- ")
}
