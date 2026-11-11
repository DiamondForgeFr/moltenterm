// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// PhraseCommand must match frontend/moltenterm-shell/boss/brokk-colleague-store.ts.
	PhraseCommand = "moltenbrokkphrase"

	// StatusLine: his model wrote a line (Line); StatusNone is every other outcome, so the window shows its written
	// phrasing and never asks the developer to set a model up.
	StatusLine = "line"

	// A moment of a kind colleague (FR-BOSS-009, AC72).
	KindHello    = "hello"
	KindBreak    = "break"
	KindHandover = "handover"

	// The agent has this long to answer. The window waits a little longer, and never for the screen: the written
	// phrasing shows meanwhile.
	phraseTimeout = 25 * time.Second
	// More than this printed is no line.
	maxPhraseOutput = 8 << 10
	// An output longer than this is no line; the window discards anything past its own, shorter limit anyway
	// (brokk-colleague.ts validModelLine).
	maxPhraseLine = 400
	// The window asks at most 5 a day (brokk-colleague.ts MaxModelCallsPerDay); this many an hour is a ceiling should a
	// window ask more.
	maxPhrasesPerHour = 8
)

var (
	languageCode = regexp.MustCompile(`^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$`)
	clockText    = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// PhraseRequest is what the window tells about a moment. These fields are the only things his model ever receives:
// nothing from a notification, a file, a pull request, a ticket, a name or a path.
type PhraseRequest struct {
	Kind      string `json:"kind"`
	Language  string `json:"language,omitempty"`
	Clock     string `json:"clock,omitempty"`
	WorkedMin int    `json:"workedmin,omitempty"`
	Agents    int    `json:"agents,omitempty"`
}

type PhraseResult struct {
	Status string `json:"status"`
	Line   string `json:"line,omitempty"`
}

func languageName(code string) string {
	switch strings.ToLower(code) {
	case "en":
		return "English"
	case "fr":
		return "French"
	}
	return fmt.Sprintf("the language whose code is %q", code)
}

func clamp(n int, low int, high int) int {
	if n < low {
		return low
	}
	if n > high {
		return high
	}
	return n
}

// phrasePrompt is the whole of what his model is told, from the validated request.
func phrasePrompt(req PhraseRequest) string {
	var moment string
	switch req.Kind {
	case KindHello:
		moment = fmt.Sprintf("The developer has just sat down for the first time today. It is %s on their clock. Greet them.", req.Clock)
	case KindBreak:
		moment = fmt.Sprintf("The developer has worked for about %d minutes without a real pause. Kindly suggest a break.", req.WorkedMin)
	default:
		moment = fmt.Sprintf("It is %s on the developer's clock and %d coding agents are still working on their own. Say that you keep an eye on them while the application is open, that what they finish will wait in the notifications, and that the developer can rest. Promise nothing else: you do not wake the developer, send a message or start any work at night.", req.Clock, req.Agents)
	}
	return fmt.Sprintf(`You are Brokk, the foreman of a software forge: a warm, slightly gruff craftsman who is also a kind colleague of the developer.

Write ONE short line that you say to the developer, in %s.

%s

Rules, all of them hard:
- One line of plain text, at most 100 characters.
- No markdown, no list, no quotation marks, no emoji, no link.
- No digit: write any number in words, or leave it out.
- Never mention a notification, a ticket, a pull request, a file, code or a name.
- Use no tool. Output the line alone, nothing before or after it.
`, languageName(req.Language), moment)
}

// validRequest keeps what the prompt is built from to a known shape: a value that is not one of these is not sent.
func validRequest(req PhraseRequest) (PhraseRequest, bool) {
	switch req.Kind {
	case KindHello, KindBreak, KindHandover:
	default:
		return req, false
	}
	if !languageCode.MatchString(req.Language) || !clockText.MatchString(req.Clock) {
		return req, false
	}
	req.WorkedMin = clamp(req.WorkedMin, 0, 24*60)
	req.Agents = clamp(req.Agents, 0, 99)
	return req, true
}

// phraseOutput is the whole of what the agent printed, trimmed: the window's one-line check (brokk-colleague.ts
// validModelLine) must see a preamble or a second line to refuse it (#2220). An output too long to be one line is
// none, rather than a cut that could drop what made it invalid.
func phraseOutput(out []byte) string {
	if len(out) > maxPhraseOutput {
		return ""
	}
	text := strings.TrimSpace(strings.ToValidUTF8(string(out), ""))
	if utf8.RuneCountInString(text) > maxPhraseLine {
		return ""
	}
	return text
}

// claimPhrase lets one phrasing run at a time.
func (s *Service) claimPhrase() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.phrasing {
		return false
	}
	s.phrasing = true
	return true
}

func (s *Service) releasePhrase() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.phrasing = false
}

// allowRun counts the run that is about to start and refuses it past a handful an hour: the window asks a handful a day,
// so a caller that asks for more is spending the developer's subscription.
func (s *Service) allowRun() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	now := time.Now()
	if s.env.Now != nil {
		now = s.env.Now()
	}
	recent := s.phrased[:0]
	for _, at := range s.phrased {
		if now.Sub(at) < time.Hour {
			recent = append(recent, at)
		}
	}
	s.phrased = recent
	if len(s.phrased) >= maxPhrasesPerHour {
		return false
	}
	s.phrased = append(s.phrased, now)
	return true
}

// Phrase asks the coding agent the developer chose for MoltenTerm to word one moment, once, with its non-interactive
// read-only form in his own folder. It answers StatusLine only with a line; no agent chosen, one that is not installed,
// a failure, a timeout and a second call while one runs are all StatusNone. It starts nothing visible and never offers
// to set an agent up (FR-BOSS-009, AC77).
func (s *Service) Phrase(ctx context.Context, req PhraseRequest) PhraseResult {
	none := PhraseResult{Status: StatusNone}
	req, ok := validRequest(req)
	if !ok || s.env.ChosenAgent == nil || s.env.RunPrint == nil || s.env.Folder == nil {
		return none
	}
	if !s.claimPhrase() {
		return none
	}
	defer s.releasePhrase()
	dir, err := s.env.Folder()
	if err != nil {
		return none
	}
	agent, ok := s.env.ChosenAgent(dir)
	if !ok || !s.allowRun() {
		return none
	}
	ctx, cancel := context.WithTimeout(ctx, phraseTimeout)
	defer cancel()
	out, err := s.env.RunPrint(ctx, dir, agent, phrasePrompt(req))
	if err != nil {
		log.Printf("[brokksession] his model could not phrase a moment: %v\n", err)
		return none
	}
	line := phraseOutput(out)
	if line == "" {
		return none
	}
	return PhraseResult{Status: StatusLine, Line: line}
}
