// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// Ask the AI (FR-REV-003): the Review tab's question goes to the session's agent as one line typed into its terminal,
// through the guarded path every typed prompt takes (the agent must be in the foreground, neither working nor waiting
// for an answer). The selection and the whole question stay in the session for review_selection, so the typed line
// only needs the reference.

const (
	// The guarded path types at most 600 bytes (termupdate's maxTypedLine); a longer question is read with
	// review_selection.
	maxAskLine     = 590
	maxQuestionLen = 8000
	askLinePrefix  = "Review question"
)

func sideName(side string) string {
	if side == mcpreview.SideLeft {
		return "base"
	}
	return "head"
}

func linesName(a *mcpreview.Anchor) string {
	if a.StartLine > 0 && a.StartLine != a.Line {
		return fmt.Sprintf("lines %d-%d", a.StartLine, a.Line)
	}
	return fmt.Sprintf("line %d", a.Line)
}

// oneLine keeps a question typable: every run of white space (new lines included) becomes one space.
func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// AskLine is the line typed for a question: the selection's reference, then the question, or a pointer to
// review_selection when the line would be too long.
func AskLine(anchor *mcpreview.Anchor, question string) string {
	ref := askLinePrefix + " on the PR"
	if anchor != nil {
		ref = fmt.Sprintf("%s on %s, %s side, %s (review_selection has them)", askLinePrefix, anchor.Path, sideName(anchor.Side), linesName(anchor))
	}
	line := ref + ": " + oneLine(question)
	if len(line) <= maxAskLine {
		return line
	}
	return ref + ": the question is long, read it with review_selection and answer it."
}

// Ask types the question into the session's terminal with its selection's reference; while the agent is busy, or
// while other questions wait, it is queued and typed once the agent is idle (FR-REV-006 AC4, questions.go).
func (m *Manager) Ask(ctx context.Context, req mcpreview.AskRequest) (mcpreview.AskResult, error) {
	m.ensureLoaded(ctx)
	question := strings.TrimSpace(req.Question)
	if question == "" {
		return mcpreview.AskResult{}, errors.New("the question is empty")
	}
	if len(question) > maxQuestionLen || len(req.Text) > mcpreview.MaxResultBytes {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrTooLarge)
	}
	if req.Anchor != nil {
		if err := checkAnchor(req.Anchor); err != nil {
			return mcpreview.AskResult{}, err
		}
	}
	s := m.find(req.SessionKey)
	if s == nil {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	if m.env.TypePrompt == nil {
		return mcpreview.AskResult{}, errors.New("MoltenTerm cannot type in the session's terminal")
	}
	q := mcpreview.QueuedQuestion{Anchor: req.Anchor, Text: req.Text, Question: question}
	line := AskLine(req.Anchor, question)
	busy := ""
	if !m.hasQuestions(s) {
		out := m.deliverQuestion(ctx, s, q)
		if !out.Retry {
			if out.Sent && m.clearQueueNote(s) {
				m.publish(s, false)
			}
			return mcpreview.AskResult{Sent: out.Sent, Submitted: out.Submitted, Line: line, Message: out.Message}, nil
		}
		busy = out.Message
	}
	q, position := m.enqueueQuestion(s, q)
	m.publish(s, false)
	// Message: why the agent could not take it now; the window says it is queued.
	return mcpreview.AskResult{Queued: true, Busy: busy != "", QuestionId: q.Id, Position: position, Line: line,
		Message: strings.TrimSpace(busy)}, nil
}

// deliverQuestion makes the question's selection the session's and types its line. A busy agent gets nothing: the
// selection goes back to what it was, since the agent may be reading it for the question it is answering.
func (m *Manager) deliverQuestion(ctx context.Context, s *session, q mcpreview.QueuedQuestion) TypeOutcome {
	if reason := m.agentBusy(s); reason != "" {
		return TypeOutcome{Retry: true, Message: reason}
	}
	sel := &mcpreview.SelectionRequest{SessionKey: mcpreview.SessionKey{Id: s.rec.Id}, Anchor: q.Anchor, Text: q.Text, Question: q.Question}
	previous := m.swapSelection(s, sel)
	out := m.env.TypePrompt(ctx, s.blockId, AskLine(q.Anchor, q.Question))
	if !out.Sent {
		m.restoreSelection(s, sel, previous)
	}
	return out
}

func (m *Manager) setSelection(s *session, sel *mcpreview.SelectionRequest) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.selection = sel
}

func (m *Manager) swapSelection(s *session, sel *mcpreview.SelectionRequest) *mcpreview.SelectionRequest {
	m.lock.Lock()
	defer m.lock.Unlock()
	previous := s.selection
	s.selection = sel
	return previous
}

// restoreSelection puts the previous selection back, unless the developer set another one meanwhile.
func (m *Manager) restoreSelection(s *session, sel *mcpreview.SelectionRequest, previous *mcpreview.SelectionRequest) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s.selection == sel {
		s.selection = previous
	}
}
