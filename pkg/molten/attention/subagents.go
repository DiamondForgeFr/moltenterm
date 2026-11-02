// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"fmt"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Sub-agents (#1092, FR-CONT-015). A session's sub-agents report through the same hooks as the session, marked with
// their agent_id (`molten agent hook`): their start, their tools, their stop. They never change the pane's state,
// which stays the main session's: a handoff waits for the main prompt only, so an agent waiting at its idle prompt
// while its background sub-agents run takes a message. The windows still show that work: while the main session is
// idle or done and sub-agents run, the published state is working, marked background, with "N sub-agents running".
//
// The set is what the hooks said, never a guess: a sub-agent whose stop was never reported (a killed agent) is
// forgotten with the run, at the session's next start, or when the set is full.
//
// A stop is not always reported (#1771): Codex's sub-agents finish their task and wait, idle, for the parent's next
// message, so no SubagentStop comes, and an interrupted turn reports nothing. When the main session's turn ends
// (subagentsTurnEnd), the set is forgotten: a sub-agent that still runs reports its next tool and counts again, one
// that ended no longer shows "N sub-agents running" next to an empty list.

const (
	maxTrackedSubagents = 64
	maxSubagentIdLength = 128
)

// subagentLocked applies a sub-agent's report: working (or waiting) means it runs, any other state that it stopped.
func (a *agentStates) subagentLocked(blockId string, rec *agentRecord, id string, state string) {
	if rec.state == "" {
		rec.state = molten.AgentStateIdle
		rec.since = a.now().UnixMilli()
		a.markDirtyLocked(blockId)
	}
	running := state == molten.AgentStateWorking || state == molten.AgentStateWaiting
	if running == rec.subagents[id] {
		return
	}
	if !running {
		delete(rec.subagents, id)
		a.markDirtyLocked(blockId)
		return
	}
	if len(rec.subagents) >= maxTrackedSubagents {
		return
	}
	if rec.subagents == nil {
		rec.subagents = map[string]bool{}
	}
	rec.subagents[id] = true
	a.markDirtyLocked(blockId)
}

// subagentsTurnEnd tells whether a report of the main session ends its turn: done, error or idle. Waiting and
// working are the turn going on.
func subagentsTurnEnd(state string) bool {
	return state == molten.AgentStateDone || state == molten.AgentStateError || state == molten.AgentStateIdle
}

func (a *agentStates) forgetSubagentsLocked(blockId string, rec *agentRecord) {
	if len(rec.subagents) == 0 {
		return
	}
	rec.subagents = nil
	a.markDirtyLocked(blockId)
}

// subagentsInfo shows a pane whose main session is idle or done, and whose sub-agents run, as working in the
// background. A state MoltenTerm holds (agenthold.go) keeps its own words.
func subagentsInfo(rec *agentRecord, info *molten.AgentStateInfo) {
	n := len(rec.subagents)
	info.Subagents = n
	if n == 0 || info.State != rec.state || (rec.state != molten.AgentStateIdle && rec.state != molten.AgentStateDone) {
		return
	}
	info.State = molten.AgentStateWorking
	info.Background = true
	if n == 1 {
		info.Message, info.MessageText = "1 sub-agent running", uimsg.Make("agentState.subagent")
		return
	}
	info.Message, info.MessageText = fmt.Sprintf("%d sub-agents running", n), uimsg.Make("agentState.subagents", "count", strconv.Itoa(n))
}
