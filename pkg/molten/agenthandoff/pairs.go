// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
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
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := []PendingEntry{}
	for id, p := range m.pending {
		if p.from.BlockId != blockId && p.to.BlockId != blockId {
			continue
		}
		// A terminal without a name has From "": the window words it, not callName's English (#1129).
		from := ""
		if p.from.named() {
			from = p.from.callName()
		}
		rtn = append(rtn, PendingEntry{RequestId: id, FromBlockId: p.from.BlockId, ToBlockId: p.to.BlockId,
			From: from, To: p.to.callName(), Goal: cut(cleanLine(p.brief.Goal), 160)})
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].RequestId < rtn[j].RequestId })
	return rtn
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
