// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// When the PR moves (a push), the Review tab shows its new head and tells the session (FR-REV-005 AC4): the session's
// tools then read the new head, and the agent is asked for a new briefing, typed into its terminal the way a handoff
// is, only while it is idle. A busy agent is not interrupted: the panel offers to ask again.

// SetHead moves a session to a new head of its PR; with Brief, the agent is asked for a new briefing of it.
func (m *Manager) SetHead(ctx context.Context, req mcpreview.SetHeadRequest) (mcpreview.BriefResult, error) {
	if !oidPattern.MatchString(req.HeadOid) {
		return mcpreview.BriefResult{}, fmt.Errorf("headoid must be a commit id")
	}
	m.ensureLoaded(ctx)
	s := m.find(req.SessionKey)
	if s == nil {
		return mcpreview.BriefResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	rec, moved := m.moveHead(s, req.HeadOid)
	if moved {
		log.Printf("%s %s#%d moved to %s\n", logPrefix, rec.Repo, rec.Number, req.HeadOid)
		if m.env.SaveRecord != nil {
			if err := m.env.SaveRecord(ctx, s.blockId, rec); err != nil {
				log.Printf("%s %s#%d: the session's record could not be saved: %v\n", logPrefix, rec.Repo, rec.Number, err)
			}
		}
		m.publish(s, false)
	}
	if !req.Brief {
		return mcpreview.BriefResult{Status: mcpreview.BriefAsked}, nil
	}
	return m.askBriefing(ctx, s, true), nil
}

// moveHead sets the session's head; the merge base and the PR's sources are read again for it.
func (m *Manager) moveHead(s *session, head string) (record, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s.rec.HeadOid == head {
		return s.rec, false
	}
	s.rec.HeadOid = head
	s.baseOid = ""
	s.sources = nil
	return s.rec, true
}

// Brief asks a session's agent for a new briefing of its head (the briefing card's "Ask again").
func (m *Manager) Brief(ctx context.Context, key mcpreview.SessionKey) (mcpreview.BriefResult, error) {
	m.ensureLoaded(ctx)
	s := m.find(key)
	if s == nil {
		return mcpreview.BriefResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	m.lock.Lock()
	s.sources = nil
	m.lock.Unlock()
	return m.askBriefing(ctx, s, false), nil
}

func (m *Manager) askBriefing(ctx context.Context, s *session, moved bool) mcpreview.BriefResult {
	if m.env.TypePrompt == nil {
		return mcpreview.BriefResult{Status: mcpreview.BriefFailed, Message: "MoltenTerm cannot type in the review terminal."}
	}
	rec := m.recOf(s)
	out := m.env.TypePrompt(ctx, s.blockId, mcpreview.BriefingPrompt(rec.HeadOid, moved))
	switch {
	case out.Sent && out.Submitted:
		return mcpreview.BriefResult{Status: mcpreview.BriefAsked}
	case out.Sent:
		return mcpreview.BriefResult{Status: mcpreview.BriefTyped, Message: "The request is in your agent's prompt, after what you were typing there: press Enter in its terminal to send it."}
	case out.Retry:
		return mcpreview.BriefResult{Status: mcpreview.BriefBusy, Message: out.Message}
	}
	return mcpreview.BriefResult{Status: mcpreview.BriefFailed, Message: out.Message}
}

// TypeOutcome is what typing a prompt into the agent did; Retry: nothing was typed, try again once the agent is idle.
type TypeOutcome struct {
	Sent      bool
	Submitted bool
	Retry     bool
	Message   string
}
