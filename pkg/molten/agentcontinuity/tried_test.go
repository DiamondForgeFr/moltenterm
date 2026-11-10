// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentcontinuity

import (
	"encoding/json"
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-AGC-001 (#2167), AC-1 and AC-4: every agent of the registry says how much it has been tried, Claude Code daily,
// Codex tested, every other one little, and the level has a date of its own.
func TestEveryRegisteredAgentHasATriedLevel(t *testing.T) {
	m := Default().Matrix()
	if _, err := time.Parse("2006-01-02", m.TriedAsOf); err != nil || m.TriedAsOf != TriedAsOf {
		t.Fatalf("tried date %q (%v), want %q", m.TriedAsOf, err, TriedAsOf)
	}
	if len(m.Agents) == 0 {
		t.Fatal("the matrix has no agents")
	}
	for _, a := range m.Agents {
		want := TriedLittle
		switch a.Id {
		case molten.AgentIdClaude:
			want = TriedDaily
		case molten.AgentIdCodex:
			want = TriedTested
		}
		if a.Tried != want {
			t.Errorf("%s: tried %q, want %q", a.Id, a.Tried, want)
		}
	}
	for _, kind := range molten.AgentKinds {
		if _, ok := TriedLevels[kind.Id]; !ok {
			t.Errorf("agent %s of molten.AgentKinds has no tried level", kind.Id)
		}
	}
	if err := checkTried(Default(), PlannedAgents, TriedLevels); err != nil {
		t.Error(err)
	}
}

// A registry that lists an agent without a level, with a level the interface does not know, or a level for no agent,
// is refused: this is the guard that keeps a new agent from shipping without one.
func TestCheckTriedRefusesAnAgentWithoutALevel(t *testing.T) {
	r := Default()
	without := func(id string) map[string]string {
		levels := maps.Clone(TriedLevels)
		delete(levels, id)
		return levels
	}
	for _, id := range []string{molten.AgentIdClaude, molten.AgentIdCodex, molten.AgentIdGemini, molten.AgentIdVibe} {
		err := checkTried(r, PlannedAgents, without(id))
		if err == nil || !strings.Contains(err.Error(), "agent "+id+":") || !strings.Contains(err.Error(), "no tried level") {
			t.Errorf("without %s: %v", id, err)
		}
	}

	badLevel := maps.Clone(TriedLevels)
	badLevel[molten.AgentIdCodex] = "often"
	if err := checkTried(r, PlannedAgents, badLevel); err == nil || !strings.Contains(err.Error(), `"often"`) {
		t.Errorf("an unknown level: %v", err)
	}

	orphan := maps.Clone(TriedLevels)
	orphan["ghost"] = TriedLittle
	if err := checkTried(r, PlannedAgents, orphan); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Errorf("a level for no agent: %v", err)
	}

	planned := append(append([]PlannedAgent(nil), PlannedAgents...), PlannedAgent{Id: "newagent", Name: "New Agent"})
	if err := checkTried(r, planned, TriedLevels); err == nil || !strings.Contains(err.Error(), "newagent") {
		t.Errorf("a new planned agent without a level: %v", err)
	}
}

// The route and molten agent list --features --json carry the level and its date.
func TestMatrixJsonCarriesTheTriedLevel(t *testing.T) {
	data, err := json.Marshal(Default().Matrix())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"triedasof":"` + TriedAsOf + `"`, `"id":"claude"`, `"tried":"daily"`, `"tried":"tested"`, `"tried":"little"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("matrix json misses %s", want)
		}
	}
}
