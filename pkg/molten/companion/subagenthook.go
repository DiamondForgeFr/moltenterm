// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The sub-agents the agents' hooks report (#988): SubagentStart and SubagentStop, which Claude Code and Codex both
// send with agent_id, agent_type and, at the end, the sub-agent's transcript path. `molten agent hook` hands them to
// the companion route; they are kept per block, in memory, for the companion's sub-agents to read (HookSubagents,
// #986). Nothing is read from the reported path here.

const (
	maxSubagentHookEvents = 64
	maxSubagentHookBlocks = 256
)

// SubagentHookEvent is one report, with when wavesrv got it (Unix milliseconds).
type SubagentHookEvent struct {
	molten.AgentSubagentRequest
	At int64 `json:"at"`
}

type subagentHookLog struct {
	lock    sync.Mutex
	byBlock map[string][]SubagentHookEvent
	last    map[string]int64
	now     func() time.Time
}

func makeSubagentHookLog() *subagentHookLog {
	return &subagentHookLog{byBlock: map[string][]SubagentHookEvent{}, last: map[string]int64{}, now: time.Now}
}

var defaultSubagentHooks = makeSubagentHookLog()

func (l *subagentHookLog) add(req molten.AgentSubagentRequest) error {
	if req.BlockId == "" {
		return fmt.Errorf("molten agent hook must run in a MoltenTerm terminal")
	}
	if req.Event != molten.SubagentEventStart && req.Event != molten.SubagentEventStop {
		return fmt.Errorf("unknown sub-agent event %q", req.Event)
	}
	if req.Agent != "" && !molten.ValidAgentId(req.Agent) {
		return fmt.Errorf("invalid agent name %q", req.Agent)
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	at := l.now().UnixMilli()
	if _, ok := l.byBlock[req.BlockId]; !ok && len(l.byBlock) >= maxSubagentHookBlocks {
		l.evictOldestLocked()
	}
	events := append(l.byBlock[req.BlockId], SubagentHookEvent{AgentSubagentRequest: req, At: at})
	if len(events) > maxSubagentHookEvents {
		events = append([]SubagentHookEvent(nil), events[len(events)-maxSubagentHookEvents:]...)
	}
	l.byBlock[req.BlockId] = events
	l.last[req.BlockId] = at
	return nil
}

func (l *subagentHookLog) evictOldestLocked() {
	oldest, oldestAt := "", int64(0)
	for blockId, at := range l.last {
		if oldest == "" || at < oldestAt {
			oldest, oldestAt = blockId, at
		}
	}
	delete(l.byBlock, oldest)
	delete(l.last, oldest)
}

func (l *subagentHookLog) list(blockId string) []SubagentHookEvent {
	l.lock.Lock()
	defer l.lock.Unlock()
	return append([]SubagentHookEvent(nil), l.byBlock[blockId]...)
}

func (l *subagentHookLog) forget(blockId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	delete(l.byBlock, blockId)
	delete(l.last, blockId)
}

// HookSubagents lists what the hooks of a block's agent reported of its sub-agents, oldest first (at most the last
// 64).
func HookSubagents(blockId string) []SubagentHookEvent {
	return defaultSubagentHooks.list(blockId)
}

// ForgetHookSubagents drops a block's reports (its terminal closed, its agent's run ended).
func ForgetHookSubagents(blockId string) {
	defaultSubagentHooks.forget(blockId)
}
