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
		"hook command":       {"molten agent hook", agentHookCommand},
		"session link":       {agenthook.CompanionSessionCommand, CompanionSessionCommand},
		"sub-agent":          {agenthook.CompanionSubagentCommand, CompanionSubagentCommand},
		"sub-agent start":    {agenthook.SubagentEventStart, SubagentEventStart},
		"sub-agent stop":     {agenthook.SubagentEventStop, SubagentEventStop},
		"session start":      {agenthook.HookEventSessionStart, ClaudeSessionHookEvent},
	}
	for what, pair := range names {
		if pair[0] != pair[1] {
			t.Errorf("%s: agenthook %q, molten %q", what, pair[0], pair[1])
		}
	}

	pairs := map[string][2]any{
		"state request": {
			AgentStateRequest{BlockId: "b", State: "done", Agent: "codex", Message: "m", TurnEnd: true, Start: true, Subagent: "a"},
			agenthook.AgentStateRequest{BlockId: "b", State: "done", Agent: "codex", Message: "m", TurnEnd: true, Start: true, Subagent: "a"},
		},
		"session request": {
			AgentSessionRequest{BlockId: "b", Agent: "codex", Path: "/p", SessionId: "s"},
			agenthook.AgentSessionRequest{BlockId: "b", Agent: "codex", Path: "/p", SessionId: "s"},
		},
		"sub-agent request": {
			AgentSubagentRequest{BlockId: "b", Agent: "codex", Event: "stop", SessionId: "s", AgentId: "a", AgentType: "explorer", TranscriptPath: "/t"},
			agenthook.AgentSubagentRequest{BlockId: "b", Agent: "codex", Event: "stop", SessionId: "s", AgentId: "a", AgentType: "explorer", TranscriptPath: "/t"},
		},
	}
	for what, pair := range pairs {
		a, _ := json.Marshal(pair[0])
		b, _ := json.Marshal(pair[1])
		if string(a) != string(b) {
			t.Errorf("%s: molten %s, agenthook %s", what, a, b)
		}
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
