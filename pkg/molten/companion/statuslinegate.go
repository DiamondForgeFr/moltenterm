// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Claude Code may run its status line several times a second (FR-PERF-012, DS-PERF-011): wavesrv handles at most one
// relay report a second per pane. A report within that second is not lost: the latest one waits and is handled when
// the second is over, so the gauges always end on the last windows the relay read.

const statusLineMinGap = time.Second

type statusLineGate struct {
	last     time.Time
	pending  *molten.AgentStatusLineRequest
	timerSet bool
}

// HandleStatusLine is what a relay report runs. Kept tells the relay whether the windows are kept (plan usage shown).
func (m *Manager) HandleStatusLine(req molten.AgentStatusLineRequest) (molten.AgentStatusLineResponse, error) {
	if req.BlockId == "" {
		return molten.AgentStatusLineResponse{}, fmt.Errorf("molten agent statusline must run in a MoltenTerm terminal")
	}
	if !usage.GaugesOn(m.currentSettings(), "claude") {
		return molten.AgentStatusLineResponse{Kept: false}, nil
	}
	now, delay := m.admitStatusLine(req)
	if now {
		if err := m.RecordStatusLine(req); err != nil {
			return molten.AgentStatusLineResponse{}, err
		}
		return molten.AgentStatusLineResponse{Kept: true}, nil
	}
	if delay > 0 {
		time.AfterFunc(delay, func() { m.flushStatusLine(req.BlockId) })
	}
	return molten.AgentStatusLineResponse{Kept: true}, nil
}

// admitStatusLine tells whether a report is handled now; if not, it waits as the block's pending one, and delay > 0
// asks the caller to start the timer that handles it.
func (m *Manager) admitStatusLine(req molten.AgentStatusLineRequest) (bool, time.Duration) {
	m.lock.Lock()
	defer m.lock.Unlock()
	now := m.now()
	g := m.statusLines[req.BlockId]
	if g == nil {
		g = &statusLineGate{}
		m.statusLines[req.BlockId] = g
	}
	since := now.Sub(g.last)
	if g.last.IsZero() || since >= m.statusLineGap || since < 0 {
		g.last = now
		g.pending = nil
		return true, 0
	}
	g.pending = &req
	if g.timerSet {
		return false, 0
	}
	g.timerSet = true
	return false, m.statusLineGap - since
}

func (m *Manager) takePendingStatusLine(blockId string) *molten.AgentStatusLineRequest {
	m.lock.Lock()
	defer m.lock.Unlock()
	g := m.statusLines[blockId]
	if g == nil {
		return nil
	}
	g.timerSet = false
	pending := g.pending
	g.pending = nil
	if pending != nil {
		g.last = m.now()
	}
	return pending
}

func (m *Manager) flushStatusLine(blockId string) {
	defer func() {
		panichandler.PanicHandler("molten:companion:statusline", recover())
	}()
	pending := m.takePendingStatusLine(blockId)
	if pending == nil {
		return
	}
	m.RecordStatusLine(*pending)
}
