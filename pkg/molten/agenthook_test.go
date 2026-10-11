// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// The molten program (pkg/molten/agenthook) speaks to the same routes with the same requests, and accepts the same
// states and agent names, as wavesrv and wsh.
func TestAgentHookMatchesMolten(t *testing.T) {
	names := map[string][2]string{
		"states route":       {agenthook.AgentStatesRoute, AgentStatesRoute},
		"state set":          {agenthook.AgentStateSetCommand, AgentStateSetCommand},
		"companion route":    {agenthook.CompanionRoute, CompanionRoute},
		"status line":        {agenthook.AgentStatusLineCommand, AgentStatusLineCommand},
		"working":            {agenthook.AgentStateWorking, AgentStateWorking},
		"waiting":            {agenthook.AgentStateWaiting, AgentStateWaiting},
		"done":               {agenthook.AgentStateDone, AgentStateDone},
		"error":              {agenthook.AgentStateError, AgentStateError},
		"idle":               {agenthook.AgentStateIdle, AgentStateIdle},
		"status line relay":  {"molten agent statusline", agentStatusLineRelay},
		"state hook command": {"molten agent state", agentStateHookCommand},
	}
	for what, pair := range names {
		if pair[0] != pair[1] {
			t.Errorf("%s: agenthook %q, molten %q", what, pair[0], pair[1])
		}
	}

	full := AgentStateRequest{BlockId: "b", State: "done", Agent: "codex", Message: "m", TurnEnd: true}
	hook := agenthook.AgentStateRequest{BlockId: "b", State: "done", Agent: "codex", Message: "m", TurnEnd: true}
	a, _ := json.Marshal(full)
	b, _ := json.Marshal(hook)
	if string(a) != string(b) {
		t.Errorf("state request: molten %s, agenthook %s", a, b)
	}

	for _, s := range []string{"working", "waiting", "done", "error", "idle", "", "Working", "busy"} {
		if ValidAgentState(s) != agenthook.ValidAgentState(s) {
			t.Errorf("state %q: molten %v, agenthook %v", s, ValidAgentState(s), agenthook.ValidAgentState(s))
		}
	}
	for _, id := range []string{"claude", "codex", "my-agent", "a", "9", "-a", "a-", "A", "a_b", "a b", "", "é",
		strings.Repeat("a", 32), strings.Repeat("a", 33), "claude\n"} {
		if ValidAgentId(id) != agenthook.ValidAgentId(id) {
			t.Errorf("agent %q: molten %v, agenthook %v", id, ValidAgentId(id), agenthook.ValidAgentId(id))
		}
	}
}
