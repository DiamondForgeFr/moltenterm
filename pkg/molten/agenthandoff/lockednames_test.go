// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2324 AC7: a first name locked for a project that no agent holds is listed as locked, not running, so a sender knows
// why a hand-off to it cannot be delivered. A name an agent holds is listed with the agents only.
func TestListNamesTheLockedNamesNoAgentHolds(t *testing.T) {
	m, env, projA, projB := makeFixture(t)
	env.locks = []molten.AgentNameLock{
		{Name: "Flore", Project: projB},
		{Name: "Camille", Project: projA},
		{Name: "étienne", Project: projA},
	}
	list, err := m.List(context.Background(), ListRequest{Token: "tokA"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Locked) != 2 || list.Locked[0].FirstName != "Flore" || list.Locked[1].FirstName != "étienne" {
		t.Fatalf("locked, in locking order and without Camille, who runs: %+v", list.Locked)
	}
	if list.Locked[0].Project != "projectb" || list.Locked[0].ProjectDir != projB {
		t.Fatalf("the project of a locked name: %+v", list.Locked[0])
	}
	if len(list.Agents) != 2 {
		t.Fatalf("a locked name is no agent: %+v", list.Agents)
	}
}

func TestListWithoutLocksHasNoLockedEntry(t *testing.T) {
	m, _, _, _ := makeFixture(t)
	list, err := m.List(context.Background(), ListRequest{Token: "tokA"})
	if err != nil {
		t.Fatal(err)
	}
	if list.Locked != nil {
		t.Fatalf("locked: %+v", list.Locked)
	}
}

// A name whose agent ended is listed again as locked.
func TestAnEndedAgentsLockedNameIsListedAsNotRunning(t *testing.T) {
	m, env, _, projB := makeFixture(t)
	env.locks = []molten.AgentNameLock{{Name: "Jérôme", Project: projB}}
	list, _ := m.List(context.Background(), ListRequest{Token: "tokA"})
	if len(list.Locked) != 0 {
		t.Fatalf("Jérôme runs: %+v", list.Locked)
	}
	endRuns(env)
	env.runs["blockA"] = molten.AgentRunInfo{BlockId: "blockA", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Camille"}
	list, err := m.List(context.Background(), ListRequest{Token: "tokA"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Locked) != 1 || list.Locked[0].FirstName != "Jérôme" {
		t.Fatalf("after Jérôme ended: %+v", list.Locked)
	}
}

// A hand-off to a locked name no agent holds says so, and nothing is asked of the developer or typed anywhere.
func TestSendToALockedNameNobodyHoldsSaysWhy(t *testing.T) {
	m, env, _, projB := makeFixture(t)
	env.locks = []molten.AgentNameLock{{Name: "Flore", Project: projB}}
	_, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "flore", Brief: Brief{Goal: "Review the parser"}})
	if err == nil || !strings.Contains(err.Error(), "Flore is locked for project projectb") || !strings.Contains(err.Error(), "not running") ||
		!strings.Contains(err.Error(), "nothing was sent") {
		t.Fatalf("send to a locked name: %v", err)
	}
	if len(env.notifications()) != 0 || len(env.typedLines()) != 0 {
		t.Fatal("nothing must be asked or typed for a name nobody holds")
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Zoé", Brief: Brief{Goal: "do it"}}); err == nil || !strings.Contains(err.Error(), "No active agent is named") {
		t.Fatalf("a name that is not locked keeps its own answer: %v", err)
	}
}
