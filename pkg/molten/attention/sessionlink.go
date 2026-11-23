// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// What the developer sets for an agent session (an autonomous mode, #2474) is checked against the session the run in the
// terminal reports now: the agent's own hooks carry its id with every report of the main session.

// setSessionId keeps the id of the main session the block's agent reports, for the agent it runs (an empty agent names
// none: the report did not say). A report of a record that does not run, or of another agent, is not the run's.
func (a *agentStates) setSessionId(blockId string, agent string, sessionId string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil || !rec.running || (agent != "" && agent != rec.agent) {
		return
	}
	rec.sessionId = sessionId
}

// noteSession keeps the session id a hook's report carries, only from the block's own local terminal and only for the
// main session (a sub-agent's report names the session it belongs to, not one that runs).
func (a *agentStates) noteSession(caller localroute.Caller, req molten.AgentStateRequest) {
	if req.SessionId == "" || req.Subagent != "" || req.BlockId == "" {
		return
	}
	if !caller.IsLocalTerminal || caller.BlockId != req.BlockId {
		return
	}
	a.setSessionId(req.BlockId, req.Agent, req.SessionId)
}
