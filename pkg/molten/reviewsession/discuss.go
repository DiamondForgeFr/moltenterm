// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// Review comments with the session's agent (FR-REV-009). Discuss: the comment and its lines become the session's
// selection and one line is typed into the agent's terminal through the guarded path Ask the AI takes; the agent
// answers with review_reply_comment, only on a comment discussed in this session. Proposals: a comment the agent
// proposes is checked against the PR's lines and completed by MoltenTerm (the lines' real text, line or file-level
// subject, the developer's language), so the developer accepts exactly what GitHub would show.

const (
	discussLinePrefix = "Review comment"
	discussNote       = "The developer discusses this review comment of theirs. Answer with review_reply_comment " +
		"(commentid above), in their language; add a rewrite only when it makes the comment clearer or fairer."
)

// DiscussLine is the line typed for Discuss: the comment's reference, then the developer's message, or a pointer to
// review_selection when the line would be too long.
func DiscussLine(anchor *mcpreview.Anchor, comment mcpreview.CommentRef, message string) string {
	what := "comment"
	if comment.Kind == mcpreview.KindChange {
		what = "change request"
	}
	ref := fmt.Sprintf("%s %s (a %s) on %s, %s side, %s (review_selection has it)", discussLinePrefix, comment.Id, what,
		anchor.Path, sideName(anchor.Side), linesName(anchor))
	text := oneLine(message)
	if text == "" {
		text = "what do you think of it? Reply with review_reply_comment."
	}
	line := ref + ": " + text
	if len(line) <= maxAskLine {
		return line
	}
	return ref + ": the message is long, read it with review_selection and reply with review_reply_comment."
}

// Discuss sends a comment to the PR's session (wavesrv's review service calls it); an error when the sessions were not
// started or the PR has none.
func Discuss(ctx context.Context, req mcpreview.DiscussRequest) (mcpreview.AskResult, error) {
	manager := liveManager.Load()
	if manager == nil {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	return manager.Discuss(ctx, req)
}

// Discuss sets the comment as the session's selection and types its line into the agent's terminal.
func (m *Manager) Discuss(ctx context.Context, req mcpreview.DiscussRequest) (mcpreview.AskResult, error) {
	m.ensureLoaded(ctx)
	if req.Comment.Id == "" || strings.TrimSpace(req.Comment.Text) == "" {
		return mcpreview.AskResult{}, errors.New("the comment to discuss is missing")
	}
	if err := checkAnchor(req.Anchor); err != nil {
		return mcpreview.AskResult{}, err
	}
	if len(req.Message) > maxQuestionLen || len(req.Comment.Text) > mcpreview.MaxResultBytes || len(req.Anchor.Excerpt) > mcpreview.MaxResultBytes {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrTooLarge)
	}
	s := m.find(req.SessionKey)
	if s == nil {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	if m.env.TypePrompt == nil {
		return mcpreview.AskResult{}, errors.New("MoltenTerm cannot type in the session's terminal")
	}
	comment := req.Comment
	m.setDiscussed(s, &mcpreview.SelectionRequest{
		SessionKey: req.SessionKey, Anchor: req.Anchor, Text: req.Anchor.Excerpt, Question: strings.TrimSpace(req.Message),
		Comment: &comment,
	})
	line := DiscussLine(req.Anchor, comment, req.Message)
	out := m.typeLine(ctx, s, line)
	return mcpreview.AskResult{Sent: out.Sent, Submitted: out.Submitted, Busy: out.Retry && !out.Starting, Starting: out.Starting, Line: line, Message: out.Message}, nil
}

func (m *Manager) setDiscussed(s *session, sel *mcpreview.SelectionRequest) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.selection = sel
	if s.discussed == nil {
		s.discussed = map[string]bool{}
	}
	s.discussed[sel.Comment.Id] = true
}

func splitText(text string) []string {
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// completeProposal checks a proposal's lines against the PR's side they name and fills its excerpt (their real text),
// its subject (a line comment inside one hunk, else file-level) and the developer's language.
func (m *Manager) completeProposal(ctx context.Context, s *session, post *mcpreview.Post) error {
	base, err := m.baseOf(ctx, s)
	if err != nil {
		return err
	}
	rec := m.recOf(s)
	anchor := *post.Anchor
	commit := rec.HeadOid
	if anchor.Side == mcpreview.SideLeft {
		commit = base
	}
	blob, err := m.env.Git(ctx, rec.ProjectDir, "cat-file", "blob", commit+":"+anchor.Path)
	if err != nil {
		return fmt.Errorf("%s is not in the PR's %s side (see review_files)", anchor.Path, sideName(anchor.Side))
	}
	lines := splitText(string(blob))
	start := anchor.StartLine
	if start <= 0 {
		start = anchor.Line
	}
	if anchor.Line > len(lines) {
		return errors.New(mcpreview.ErrLineNotInFile)
	}
	anchor.Excerpt = strings.Join(lines[start-1:anchor.Line], "\n")
	anchor.HeadOid = rec.HeadOid
	post.Anchor = &anchor
	post.Subject = "file"
	out, err := m.env.Git(ctx, rec.ProjectDir, "diff", "--no-color", "--no-ext-diff", "-U"+strconv.Itoa(mcpreview.HunkContext), base, rec.HeadOid, "--", anchor.Path)
	if err == nil && mcpreview.InHunk(mcpreview.ParseHunks(out), anchor.Side, start, anchor.Line) {
		post.Subject = "line"
	}
	post.Lang = m.developerLanguage()
	return nil
}
