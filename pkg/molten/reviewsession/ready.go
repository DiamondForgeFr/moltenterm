// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A just-started session's agent is not ready for a typed prompt (#638): until its state hooks report, the guarded
// typing path cannot tell its prompt is empty and types without Enter, and until its review tools connect it would
// answer without them. Every review action that types into a session (Ask the AI and its queue, Discuss, the
// translation request) goes through typeLine, which types nothing while the agent is starting; the Review tab sends
// again until it is ready (review-ready.ts).

const (
	// After this long from the session's start, the agent is taken as ready whatever it reported, so an agent that
	// never connects its tools still gets the line (typed without Enter when its prompt cannot be read).
	readyGrace = 30 * time.Second
	// An agent without state hooks never reports: once its tools connected, it is given this long.
	hookGrace = 5 * time.Second
)

// agentStarting says why the session's agent cannot take a typed prompt yet, "" when it is ready. Without AgentHooked
// the manager cannot tell, and types right away.
func (m *Manager) agentStarting(s *session) string {
	if m.env.AgentHooked == nil {
		return ""
	}
	now := m.env.Now()
	rec := m.recOf(s)
	if now.Sub(time.UnixMilli(rec.StartedAt)) >= readyGrace {
		return ""
	}
	starting := molten.AgentDisplayName(rec.Agent) + " is starting: this is sent once it is ready."
	connectedAt := m.connectedSince(s)
	if connectedAt.IsZero() {
		return starting
	}
	if m.env.AgentHooked(s.blockId) || now.Sub(connectedAt) >= hookGrace {
		return ""
	}
	return starting
}

// connectedSince is when the session's review tools first connected, zero while they are not connected.
func (m *Manager) connectedSince(s *session) time.Time {
	if !m.connected(s.rec.Id) {
		return time.Time{}
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	return s.connectedAt
}

func (m *Manager) markConnected(s *session) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s.connectedAt.IsZero() {
		s.connectedAt = m.env.Now()
	}
}

// typeLine types a line into the session's agent through the guarded path, once the agent is ready: while it starts,
// nothing is typed and the outcome says so (Retry and Starting).
func (m *Manager) typeLine(ctx context.Context, s *session, line string) TypeOutcome {
	if reason := m.agentStarting(s); reason != "" {
		return TypeOutcome{Retry: true, Starting: true, Message: reason}
	}
	return m.env.TypePrompt(ctx, s.blockId, line)
}
