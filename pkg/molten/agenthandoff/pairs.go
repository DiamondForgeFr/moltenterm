// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

const (
	// What a window reads of a pending brief before the developer answers: the receiver's brief holds the whole.
	maxPendingContext = 8000
	maxPendingExcerpt = 2000
)

// The terminal's connections menu (FR-CONT-022, #1050) shows a pane's handoffs: every other active agent with the
// pair's decision, and the requests waiting for the developer. Revoke and Unblock forget a decision, so the next send
// asks again (NFR-CONT-005); a pending request is answered there through Answer, like its notification.

// Pairs reads a pane's handoffs for a window.
func (m *Manager) Pairs(ctx context.Context, source string, req PairsRequest) (PairsResult, error) {
	if !isUiSource(source) {
		return PairsResult{}, errors.New(errNotUi)
	}
	rtn := PairsResult{Agents: []PairEntry{}, Pending: []PendingEntry{}}
	if req.BlockId == "" {
		return rtn, nil
	}
	seen := map[string]bool{}
	for _, e := range m.activeParties(ctx) {
		if e.blockId == req.BlockId {
			continue
		}
		seen[e.blockId] = true
		rtn.Agents = append(rtn.Agents, PairEntry{BlockId: e.blockId, FirstName: e.FirstName, Agent: e.Agent,
			AgentName: e.AgentName, Project: e.Project, Decision: m.pairDecision(pairKey(req.BlockId, e.blockId))})
	}
	// A decision stays for a pane whose agent ended until MoltenTerm restarts: it is shown, and can be revoked.
	for other, decision := range m.pairsOf(req.BlockId) {
		if seen[other] {
			continue
		}
		entry := PairEntry{BlockId: other, Decision: decision}
		if run, ok := m.env.Run(other); ok {
			entry.FirstName, entry.Agent = run.FirstName, run.Agent
		}
		rtn.Agents = append(rtn.Agents, entry)
	}
	sort.SliceStable(rtn.Agents, func(i, j int) bool {
		return foldName(rtn.Agents[i].FirstName) < foldName(rtn.Agents[j].FirstName)
	})
	rtn.Pending = m.pendingOf(req.BlockId)
	return rtn, nil
}

// pairsOf: the other pane and the decision of each remembered pair holding blockId.
func (m *Manager) pairsOf(blockId string) map[string]string {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := map[string]string{}
	for key, decision := range m.pairs {
		a, b, ok := strings.Cut(key, "|")
		if !ok {
			continue
		}
		switch blockId {
		case a:
			rtn[b] = decision
		case b:
			rtn[a] = decision
		}
	}
	return rtn
}

func (m *Manager) pendingOf(blockId string) []PendingEntry {
	rtn := m.pendingEntries(func(p *pendingAnswer) bool { return p.from.BlockId == blockId || p.to.BlockId == blockId }, false)
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].RequestId < rtn[j].RequestId })
	return rtn
}

// pendingEntries lists the waiting requests; detailed adds where each end works and the brief, for the card that
// answers them (#1891), which the connections menu's poll does not need.
func (m *Manager) pendingEntries(keep func(p *pendingAnswer) bool, detailed bool) []PendingEntry {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := []PendingEntry{}
	for id, p := range m.pending {
		if !keep(p) {
			continue
		}
		// A terminal without a name has From "": the window words it, not callName's English (#1129).
		from := ""
		if p.from.named() {
			from = p.from.callName()
		}
		entry := PendingEntry{RequestId: id, FromBlockId: p.from.BlockId, ToBlockId: p.to.BlockId,
			From: from, To: p.to.callName(), Goal: cut(cleanLine(p.brief.Goal), 160), CreatedAt: p.asked.UnixMilli()}
		if detailed {
			entry.FromWorkspace, entry.ToWorkspace = p.from.Workspace, p.to.Workspace
			entry.FromProject, entry.ToProject = p.from.Project, p.to.Project
			entry.Brief = pendingBriefOf(p.brief)
		}
		rtn = append(rtn, entry)
	}
	return rtn
}

func pendingBriefOf(b Brief) *PendingBrief {
	rtn := &PendingBrief{Goal: b.Goal, Context: cut(b.Context, maxPendingContext), Reply: b.Reply}
	for _, f := range b.Files {
		rtn.Files = append(rtn.Files, PendingFile{Path: f.Path, Project: f.Project, Lines: f.Lines, Note: f.Note,
			Excerpt: cut(f.Excerpt, maxPendingExcerpt)})
	}
	for _, l := range b.Links {
		rtn.Links = append(rtn.Links, PendingLink{Url: l.Url, Title: l.Title, Kind: l.Kind, Note: l.Note})
	}
	return rtn
}

// Pending gives a window every request waiting for the developer, in every workspace, oldest first (#1926). Any
// surface that lists them answers an entry with AnswerCommand, as the notification's buttons do.
func (m *Manager) Pending(source string) (PendingResult, error) {
	if !isUiSource(source) {
		return PendingResult{}, errors.New(errNotUi)
	}
	entries := m.pendingEntries(func(p *pendingAnswer) bool { return true }, true)
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].CreatedAt != entries[j].CreatedAt {
			return entries[i].CreatedAt < entries[j].CreatedAt
		}
		return entries[i].RequestId < entries[j].RequestId
	})
	return PendingResult{Entries: entries}, nil
}

// Forget is a window's Revoke or Unblock: the pair's next send asks the developer again.
func (m *Manager) Forget(source string, req ForgetRequest) error {
	if !isUiSource(source) {
		return errors.New(errNotUi)
	}
	if req.BlockId == "" || req.OtherBlockId == "" {
		return uimsg.Errorf(uimsg.Make("handoff.forget.nopair"), "name both terminals of the pair")
	}
	key := pairKey(req.BlockId, req.OtherBlockId)
	decision := m.forgetPair(key)
	if decision != "" {
		m.logf("%s pair decision %q forgotten by the developer\n", logPrefix, decision)
	}
	return nil
}

func (m *Manager) forgetPair(key string) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	decision := m.pairs[key]
	delete(m.pairs, key)
	return decision
}
