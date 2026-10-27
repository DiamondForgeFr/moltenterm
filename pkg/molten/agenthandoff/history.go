// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import "errors"

// The agents a pane is linked to (FR-SHELL-084, #1188): the sidebar's agent tree and the agent window list the
// handoffs in and out of each agent. MoltenTerm keeps the ones it passed on since it started, in memory and bounded;
// the receiver's "handed by" block meta (RecordHandoff) is what survives a restart.

const (
	maxHistory        = 200
	maxHistoryGoalLen = 160
)

func (m *Manager) addHistory(from Party, to Party, brief Brief) {
	if from.BlockId == "" || to.BlockId == "" {
		return
	}
	entry := HistoryEntry{
		FromBlockId: from.BlockId,
		ToBlockId:   to.BlockId,
		From:        from.FirstName,
		To:          to.FirstName,
		Goal:        cut(cleanLine(brief.Goal), maxHistoryGoalLen),
		At:          m.now().UnixMilli(),
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	m.history = append(m.history, entry)
	if len(m.history) > maxHistory {
		m.history = append([]HistoryEntry(nil), m.history[len(m.history)-maxHistory:]...)
	}
}

// History gives a window the handoffs passed on since MoltenTerm started, oldest first.
func (m *Manager) History(source string) (HistoryResult, error) {
	if !isUiSource(source) {
		return HistoryResult{}, errors.New(errNotUi)
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	return HistoryResult{Entries: append([]HistoryEntry{}, m.history...)}, nil
}
