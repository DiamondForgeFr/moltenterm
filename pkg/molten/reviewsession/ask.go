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

// Ask sets the session's selection and types the question into its terminal.
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
	m.setSelection(s, &mcpreview.SelectionRequest{SessionKey: req.SessionKey, Anchor: req.Anchor, Text: req.Text, Question: question})
	line := AskLine(req.Anchor, question)
	out := m.env.TypePrompt(ctx, s.blockId, line)
	return mcpreview.AskResult{Sent: out.Sent, Submitted: out.Submitted, Busy: out.Retry, Line: line, Message: out.Message}, nil
}

func (m *Manager) setSelection(s *session, sel *mcpreview.SelectionRequest) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.selection = sel
}
