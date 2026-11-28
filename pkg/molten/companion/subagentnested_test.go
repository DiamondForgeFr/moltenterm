// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #2587: a lead delegates the planning of a ticket to a background sub-agent, which starts Explore agents of its own.
// Claude Code 2.1.332 lays every one of them out in the session's subagents/ folder; the meta of a sub-agent's own
// sub-agent names the agent that started it (parentAgentId). The planner's turn ends on them, so its meta says
// finished. The companion keeps the planner at work while they run, and they carry its ticket.

const (
	nestedPlanner = "a2587planner0001"
	nestedExplore = "a2587explore0001"
	nestedSecond  = "a2587explore0002"
)

// nestedAgent writes a sub-agent's meta file and transcript as Claude Code lays them out, parent "" for one the
// session started.
func nestedAgent(t *testing.T, f settleFixture, agentId string, callId string, description string, parent string, finished bool, at time.Time) {
	t.Helper()
	meta := map[string]any{"agentType": "Explore", "description": description, "toolUseId": callId, "spawnDepth": 1}
	if parent != "" {
		meta["parentAgentId"] = parent
		meta["spawnDepth"] = 2
	}
	if finished {
		meta["finished"] = true
	}
	data, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{
		"agent-" + agentId + ".meta.json": data,
		"agent-" + agentId + ".jsonl":     []byte(`{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"text","text":"Reading."}]}}` + "\n"),
	} {
		path := filepath.Join(f.subs, name)
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
}

func identityOf(ids []SubagentIdentity, agentId string) SubagentIdentity {
	for _, id := range ids {
		if id.AgentId == agentId {
			return id
		}
	}
	return SubagentIdentity{}
}

func infoOf(subs []SubagentInfo, agentId string) SubagentInfo {
	for _, s := range subs {
		if s.AgentId == agentId {
			return s
		}
	}
	return SubagentInfo{}
}

func TestNestedSubagentsNameTheirParent(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	now := time.Now()
	nestedAgent(t, f, nestedPlanner, "toolu_plan", "Analyse + plan #9587", "", true, now.Add(-10*time.Minute))
	nestedAgent(t, f, nestedExplore, "toolu_explore1", "Find the ticket links", nestedPlanner, false, now)

	ids := ApplyHookSubagents(a.ListSubagents(f.session), nil, now)
	explore := identityOf(ids, nestedExplore)
	if explore.ParentId != nestedPlanner || explore.State != SubagentRunning {
		t.Fatalf("the Explore agent names the planner that started it and runs: %+v", explore)
	}
	planner := identityOf(ids, nestedPlanner)
	if planner.ParentId != "" {
		t.Errorf("the session's own sub-agent has no parent: %+v", planner)
	}
	if planner.State != SubagentRunning || planner.Finished || !planner.Waiting {
		t.Errorf("the planner waits on its Explore agent, at work although its meta says finished: %+v", planner)
	}
}

func TestNestedSubagentEndsLeaveTheirParentDone(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	now := time.Now()
	nestedAgent(t, f, nestedPlanner, "toolu_plan", "Analyse + plan #9587", "", true, now.Add(-time.Minute))
	nestedAgent(t, f, nestedExplore, "toolu_explore1", "Find the ticket links", nestedPlanner, true, now.Add(-2*time.Minute))

	ids := ApplyHookSubagents(a.ListSubagents(f.session), nil, now)
	if planner := identityOf(ids, nestedPlanner); planner.State != SubagentDone || planner.Waiting {
		t.Errorf("once its own sub-agents ended, the planner's end shows: %+v", planner)
	}
}

func TestNestedSubagentsMetaParentIsChecked(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		parent string
		want   string
	}{
		{"its own id", nestedExplore, ""},
		{"a path", "../agent-x", ""},
		{"a valid id", nestedPlanner, nestedPlanner},
	}
	for _, tc := range cases {
		id := claudeIdentity(nestedExplore, claudeSubagentMeta{ParentAgentId: tc.parent}, 0, 0)
		if id.ParentId != tc.want {
			t.Errorf("%s: parent %q, want %q", tc.name, id.ParentId, tc.want)
		}
	}
}

// The companion's rows: the planner the lead started, its Explore agents added from their files under it, with its
// ticket, and the planner at work while they run.
func TestNestedSubagentsSitUnderTheirParentInTheSession(t *testing.T) {
	t.Parallel()
	f := makeSettleFixture(t)
	a := MakeClaudeAdapter([]string{filepath.Dir(filepath.Dir(f.session))})
	now := time.Now()
	nestedAgent(t, f, nestedPlanner, "toolu_plan", "Analyse + plan #9587", "", true, now.Add(-10*time.Minute))
	nestedAgent(t, f, nestedExplore, "toolu_explore1", "Find the ticket links", nestedPlanner, false, now)
	nestedAgent(t, f, nestedSecond, "toolu_explore2", "Read the hold model", nestedPlanner, false, now)

	s := MakeSession()
	s.StartSubagent("toolu_plan", "Analyse + plan #9587", "sf-plan", "", "", true, now.Add(-20*time.Minute).UnixMilli())
	s.SetSubagentId("toolu_plan", nestedPlanner)
	s.SettleSubagentFiles(readSubagentFiles(a, f.session, s.settledAgentIds()), now.UnixMilli())
	s.ResolveTickets(nil)

	subs := s.Subagents()
	if len(subs) != 3 {
		t.Fatalf("the planner and its two Explore agents: %+v", subs)
	}
	planner := infoOf(subs, nestedPlanner)
	if planner.State != SubagentRunning || !planner.Waiting || planner.Ended != 0 {
		t.Errorf("the planner stays at work, waiting on its Explore agents: %+v", planner)
	}
	for _, agentId := range []string{nestedExplore, nestedSecond} {
		explore := infoOf(subs, agentId)
		if explore.ParentId != nestedPlanner || explore.State != SubagentRunning {
			t.Errorf("%s sits under the planner and runs: %+v", agentId, explore)
		}
		if explore.Ticket != 9587 {
			t.Errorf("%s carries the planner's ticket: %+v", agentId, explore)
		}
	}

	// The Explore agents end: the planner's own end shows again.
	nestedAgent(t, f, nestedExplore, "toolu_explore1", "Find the ticket links", nestedPlanner, true, now)
	nestedAgent(t, f, nestedSecond, "toolu_explore2", "Read the hold model", nestedPlanner, true, now)
	s.SettleSubagentFiles(readSubagentFiles(a, f.session, s.settledAgentIds()), now.UnixMilli())
	if planner := infoOf(s.Subagents(), nestedPlanner); planner.State != SubagentDone || planner.Waiting {
		t.Errorf("the planner is done once its Explore agents ended: %+v", planner)
	}
}

// A sub-agent with a ticket of its own keeps it; one the session started never takes another's.
func TestNestedSubagentKeepsItsOwnTicket(t *testing.T) {
	t.Parallel()
	s := MakeSession()
	at := time.Now().UnixMilli()
	s.StartSubagent("toolu_plan", "Analyse + plan #9587", "sf-plan", "", "", true, at)
	s.SetSubagentId("toolu_plan", nestedPlanner)
	s.StartSubagent("toolu_other", "Read the docs", "Explore", "", "", true, at)
	s.AddFoundSubagent(FoundSubagent{AgentId: nestedExplore, ParentId: nestedPlanner, Name: "#9600 port", Nested: true, Started: at})
	s.AddFoundSubagent(FoundSubagent{AgentId: nestedSecond, ParentId: nestedPlanner, Name: "explorer", Nested: true, Started: at})
	s.ResolveTickets(nil)
	subs := s.Subagents()
	if got := infoOf(subs, nestedExplore); got.Ticket != 9600 || got.ParentId != nestedPlanner {
		t.Errorf("its own ticket first: %+v", got)
	}
	if got := infoOf(subs, nestedSecond); got.Ticket != 9587 || got.ParentId != nestedPlanner {
		t.Errorf("a Codex sub-agent's own sub-agent carries its parent's ticket: %+v", got)
	}
	for _, sub := range subs {
		if sub.Id == "toolu_other" && sub.Ticket != 0 {
			t.Errorf("the session's own sub-agent never inherits: %+v", sub)
		}
	}
}
