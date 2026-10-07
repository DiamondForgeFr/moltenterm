// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestTurnEndListener(t *testing.T) {
	got := make(chan [2]string, 1)
	SetTurnEndListener(func(blockId string, agent string) { got <- [2]string{blockId, agent} })
	defer SetTurnEndListener(nil)
	defer defaultAgentStates.forgetRecord("turnend-block")

	turnEnded("turnend-block")
	select {
	case ev := <-got:
		t.Fatalf("no run known, no turn end: %v", ev)
	case <-time.After(50 * time.Millisecond):
	}

	// The record a hook's report makes, without the report's side effects (it remembers the agent's hooks on disk).
	defaultAgentStates.lock.Lock()
	defaultAgentStates.records["turnend-block"] = &agentRecord{agent: "claude", running: true, state: molten.AgentStateDone, source: sourceHook}
	defaultAgentStates.lock.Unlock()
	turnEnded("turnend-block")
	select {
	case ev := <-got:
		if ev != [2]string{"turnend-block", "claude"} {
			t.Fatalf("listener got %v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the listener was not called")
	}
}
