// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// Drafting review comments (FR-REV-009): a comment is a remark or question for the author (kind comment) or a change
// request (kind change), written in the developer's language. The developer edits, stages, unstages, drops and
// restores it; only staged comments go to the next publication (FR-REV-010). The review session's agent may propose
// comments (review_propose_comment): they stay proposals until the developer accepts them. Discuss sends a comment to
// the session; the agent's reply (review_reply_comment) is kept under it, with a rewrite the developer uses or
// ignores. Every comment keeps its original text and each later state in its history (DS-REV-007). Nothing here
// leaves MoltenTerm.

// What happened to a comment, in its history.
const (
	EventCreated   = "created"
	EventProposed  = "proposed"
	EventEdited    = "edited"
	EventKind      = "kind"
	EventStaged    = "staged"
	EventUnstaged  = "unstaged"
	EventDropped   = "dropped"
	EventRestored  = "restored"
	EventAccepted  = "accepted"
	EventRewritten = "rewritten"
)

// The developer's actions on a comment (CommentStateRequest.Action).
const (
	ActionStage   = "stage"
	ActionUnstage = "unstage"
	ActionDrop    = "drop"
	ActionRestore = "restore"
	ActionAccept  = "accept"
)

// Who wrote a message of a comment's discussion, and what became of the agent's rewrite.
const (
	MessageByDeveloper = "developer"
	MessageByAgent     = "agent"

	RewriteProposed = "proposed"
	RewriteAccepted = "accepted"
	RewriteIgnored  = "ignored"
)

const (
	// The first event (the original text) is always kept; the latest ones after it.
	maxHistory    = 200
	maxDiscussion = 100
)

// CommentEvent is one entry of a comment's history: the state after it, and the text when it changed.
type CommentEvent struct {
	At    int64  `json:"at"`
	Event string `json:"event"`
	State string `json:"state"`
	Kind  string `json:"kind,omitempty"`
	Text  string `json:"text,omitempty"`
	By    string `json:"by"`
}

// CommentMessage is one message of a comment's discussion with the review session: the developer's (Text may be
// empty: Discuss without a message) or the agent's reply (markdown), with an optional rewrite of the comment.
type CommentMessage struct {
	Id           string `json:"id"`
	At           int64  `json:"at"`
	By           string `json:"by"`
	Text         string `json:"text,omitempty"`
	Rewrite      string `json:"rewrite,omitempty"`
	RewriteState string `json:"rewritestate,omitempty"`
	Agent        string `json:"agent,omitempty"`
}

// CommentStateRequest is one of the developer's actions on a comment.
type CommentStateRequest struct {
	PrKey
	Id     string `json:"id"`
	Action string `json:"action"`
}

// RewriteRequest uses (Accept) or ignores the rewrite an agent's reply proposed.
type RewriteRequest struct {
	PrKey
	Id        string `json:"id"`
	MessageId string `json:"messageid"`
	Accept    bool   `json:"accept"`
}

// DiscussRequest is Discuss on a comment, with the developer's optional message.
type DiscussRequest struct {
	PrKey
	Id      string `json:"id"`
	Message string `json:"message,omitempty"`
}

type DiscussResult struct {
	mcpreview.AskResult
	State *State `json:"state,omitempty"`
}

func addEvent(c *Comment, at int64, event string, by string, text string) {
	c.History = append(c.History, CommentEvent{At: at, Event: event, State: c.State, Kind: c.Kind, Text: text, By: by})
	if len(c.History) > maxHistory {
		c.History = append(c.History[:1], c.History[len(c.History)-maxHistory+1:]...)
	}
}

// addMessage keeps the discussion in time order: the agent's reply may be kept before the developer's message that
// asked for it, which is only stored once Discuss returned.
func addMessage(c *Comment, msg CommentMessage) {
	i := len(c.Discussion)
	for i > 0 && c.Discussion[i-1].At > msg.At {
		i--
	}
	c.Discussion = append(c.Discussion, CommentMessage{})
	copy(c.Discussion[i+1:], c.Discussion[i:])
	c.Discussion[i] = msg
	if len(c.Discussion) > maxDiscussion {
		c.Discussion = c.Discussion[len(c.Discussion)-maxDiscussion:]
	}
}

// restoredState: a dropped proposal comes back as a proposal, anything else as a draft.
func restoredState(c *Comment) string {
	if c.Author == AuthorAgent {
		return CommentStateProposed
	}
	return CommentStateDraft
}

// applyAction changes a comment's state, or says why it cannot.
func applyAction(c *Comment, action string) (string, error) {
	if c.State == CommentStatePublished {
		return "", fmt.Errorf("this comment is published on GitHub: it stays as it is")
	}
	switch action {
	case ActionStage:
		if c.State != CommentStateDraft {
			return "", fmt.Errorf("only a draft can be staged (this comment is %s)", c.State)
		}
		c.State = CommentStateStaged
		return EventStaged, nil
	case ActionUnstage:
		if c.State != CommentStateStaged && c.State != CommentStateTranslated {
			return "", fmt.Errorf("this comment is not staged")
		}
		c.State = CommentStateDraft
		return EventUnstaged, nil
	case ActionDrop:
		if c.State == CommentStateDropped {
			return "", fmt.Errorf("this comment is already dropped")
		}
		c.State = CommentStateDropped
		return EventDropped, nil
	case ActionRestore:
		if c.State != CommentStateDropped {
			return "", fmt.Errorf("only a dropped comment can be restored")
		}
		c.State = restoredState(c)
		return EventRestored, nil
	case ActionAccept:
		if c.State != CommentStateProposed {
			return "", fmt.Errorf("only a proposal can be accepted")
		}
		c.State = CommentStateStaged
		c.Author = AuthorAcceptedProposal
		return EventAccepted, nil
	}
	return "", fmt.Errorf("action must be stage, unstage, drop, restore or accept")
}

// SetCommentState is the developer's stage, unstage, drop, restore or accept (AC1, AC3).
func (s *Store) SetCommentState(req CommentStateRequest) (State, bool, error) {
	var actErr error
	state, changed, err := s.update(req.PrKey, func(state *State) bool {
		c := findComment(state, req.Id)
		if c == nil {
			actErr = fmt.Errorf("no comment has the id %s", req.Id)
			return false
		}
		event, err := applyAction(c, req.Action)
		if err != nil {
			actErr = err
			return false
		}
		now := s.now().UnixMilli()
		addEvent(c, now, event, MessageByDeveloper, "")
		c.UpdatedAt = now
		return true
	})
	if actErr != nil {
		return state, false, actErr
	}
	return state, changed, err
}

// UseRewrite takes or ignores the rewrite of one of the agent's replies (AC2).
func (s *Store) UseRewrite(req RewriteRequest) (State, bool, error) {
	var useErr error
	state, changed, err := s.update(req.PrKey, func(state *State) bool {
		c := findComment(state, req.Id)
		if c == nil {
			useErr = fmt.Errorf("no comment has the id %s", req.Id)
			return false
		}
		var msg *CommentMessage
		for i := range c.Discussion {
			if c.Discussion[i].Id == req.MessageId {
				msg = &c.Discussion[i]
			}
		}
		if msg == nil || msg.Rewrite == "" {
			useErr = fmt.Errorf("this reply proposes no rewrite")
			return false
		}
		if msg.RewriteState != RewriteProposed {
			useErr = fmt.Errorf("this rewrite was already %s", msg.RewriteState)
			return false
		}
		if !req.Accept {
			msg.RewriteState = RewriteIgnored
			return true
		}
		if !isEditable(c) {
			useErr = fmt.Errorf("this comment is %s: it cannot be changed", c.State)
			return false
		}
		now := s.now().UnixMilli()
		msg.RewriteState = RewriteAccepted
		if c.Original.Text != msg.Rewrite {
			c.Original.Text = msg.Rewrite
			c.Translation = nil
			if c.State == CommentStateTranslated {
				c.State = CommentStateStaged
			}
		}
		addEvent(c, now, EventRewritten, MessageByDeveloper, msg.Rewrite)
		c.UpdatedAt = now
		return true
	})
	if useErr != nil {
		return state, false, useErr
	}
	return state, changed, err
}

// AddDeveloperMessage keeps the developer's message once Discuss reached the session, at the time it was sent.
func (s *Store) AddDeveloperMessage(k PrKey, id string, text string, at int64) (State, bool, error) {
	return s.update(k, func(state *State) bool {
		c := findComment(state, id)
		if c == nil {
			return false
		}
		addMessage(c, CommentMessage{Id: uuid.NewString(), At: at, By: MessageByDeveloper, Text: text})
		return true
	})
}

// AddProposal keeps a comment the agent proposed, on the head the session reviewed (AC3).
func (s *Store) AddProposal(k PrKey, post mcpreview.Post) (State, bool, error) {
	if post.Anchor == nil || strings.TrimSpace(post.Text) == "" || !isOid(post.HeadOid) {
		return State{}, false, fmt.Errorf("the proposal has no anchor, text or head")
	}
	anchor := *post.Anchor
	anchor.HeadOid = post.HeadOid
	if err := checkAnchor(&anchor); err != nil {
		return State{}, false, err
	}
	kind := post.CommentKind
	if kind != CommentKindChange {
		kind = CommentKindComment
	}
	subject := post.Subject
	if subject != SubjectFile {
		subject = SubjectLine
	}
	text := strings.TrimSpace(post.Text)
	if len(text) > maxCommentBytes {
		return State{}, false, fmt.Errorf("the proposal is too long")
	}
	return s.update(k, func(state *State) bool {
		if len(state.Comments) >= maxComments {
			return false
		}
		at := post.At
		if at == 0 {
			at = s.now().UnixMilli()
		}
		c := Comment{
			Id: uuid.NewString(), Anchor: anchor, Subject: subject, Kind: kind, State: CommentStateProposed,
			Original: CommentText{Lang: post.Lang, Text: text}, Author: AuthorAgent, CreatedAt: at,
		}
		addEvent(&c, at, EventProposed, MessageByAgent, text)
		state.Comments = append(state.Comments, c)
		return true
	})
}

// AddReply keeps the agent's reply under the comment it discussed (AC2); a reply to a comment no longer open is
// dropped.
func (s *Store) AddReply(k PrKey, post mcpreview.Post) (State, bool, error) {
	if strings.TrimSpace(post.Markdown) == "" || post.CommentId == "" {
		return State{}, false, fmt.Errorf("the reply has no comment or text")
	}
	return s.update(k, func(state *State) bool {
		c := findComment(state, post.CommentId)
		if c == nil || !isEditable(c) {
			return false
		}
		msg := CommentMessage{Id: uuid.NewString(), At: post.At, By: MessageByAgent, Text: post.Markdown, Agent: post.Agent}
		if rewrite := strings.TrimSpace(post.Text); rewrite != "" && rewrite != c.Original.Text {
			msg.Rewrite, msg.RewriteState = rewrite, RewriteProposed
		}
		if msg.At == 0 {
			msg.At = s.now().UnixMilli()
		}
		addMessage(c, msg)
		return true
	})
}

// Discuss sends a comment to the review session (AC2): its lines become the session's selection with the comment, and
// one line is typed into the agent's terminal. The developer's message is kept once the line reached the agent.
func (s *Service) Discuss(ctx context.Context, req DiscussRequest) (DiscussResult, error) {
	message := strings.TrimSpace(req.Message)
	if len(message) > maxCommentBytes {
		return DiscussResult{}, fmt.Errorf("the message is too long (64 KB at most)")
	}
	state, err := s.store.Get(req.PrKey)
	if err != nil {
		return DiscussResult{}, err
	}
	c := findComment(&state, req.Id)
	if c == nil {
		return DiscussResult{}, fmt.Errorf("no comment has the id %s", req.Id)
	}
	if !isEditable(c) {
		return DiscussResult{}, fmt.Errorf("this comment is %s: there is nothing left to discuss", c.State)
	}
	if s.discuss == nil {
		return DiscussResult{}, fmt.Errorf("MoltenTerm cannot reach the review session")
	}
	anchor := c.Anchor
	sentAt := s.store.now().UnixMilli()
	result, err := s.discuss(ctx, mcpreview.DiscussRequest{
		SessionKey: mcpreview.SessionKey{Repo: req.Repo, Number: req.Number},
		Anchor:     &anchor,
		Comment: mcpreview.CommentRef{
			Id: c.Id, Kind: c.Kind, Subject: c.Subject, State: c.State, Text: c.Original.Text, Lang: c.Original.Lang,
			Outdated: c.Outdated,
		},
		Message: message,
	})
	if err != nil {
		return DiscussResult{}, err
	}
	rtn := DiscussResult{AskResult: result}
	if !result.Sent {
		return rtn, nil
	}
	next, err := s.changed(s.store.AddDeveloperMessage(req.PrKey, req.Id, message, sentAt))
	if err == nil {
		rtn.State = &next
	}
	return rtn, nil
}
