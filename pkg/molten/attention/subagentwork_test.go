// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2502: a lead whose turn ended while its sub-agents wait on their own tests or builds still has them at work. What
// the sub-agents' own files say reaches the agent states through pkg/molten/subagentwork, which the companion fills.

func waitingWork(id string, kind string) molten.SubagentWork {
	return molten.SubagentWork{Id: id, Description: "#1 " + id, Kind: "sf-fix", Started: 100, Waiting: true, Jobs: []molten.BackgroundJob{{Kind: kind, Since: 200}}}
}

func TestLeadCountsSubagentsWaitingOnTheirTestsAfterItsTurnEnded(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "lead", hookMainPrompt, hookSubStart, hookMainStop)
	h.hookRun(t, "other", hookMainPrompt, hookMainStop)
	if info := h.info("lead"); info.State != molten.AgentStateDone || info.Subagents != 0 || info.Background {
		t.Fatalf("the turn ended and the hooks forgot the sub-agent: %+v", info)
	}

	h.states.dirty = map[string]bool{}
	h.states.work.Set("lead", []molten.SubagentWork{waitingWork("a-1", molten.JobVitest), waitingWork("a-2", molten.JobBuildFrontend)})
	if !h.states.dirty["lead"] || h.states.dirty["other"] {
		t.Errorf("the lead is published again, and only the lead: %v", h.states.dirty)
	}
	info := h.info("lead")
	if info.State != molten.AgentStateWorking || !info.Background || info.Subagents != 2 || len(info.Work) != 2 {
		t.Fatalf("the lead is at work through its two sub-agents: %+v", info)
	}
	if info.MessageText == nil || info.MessageText.Code != "agentState.subagents" || info.MessageText.Vars["count"] != "2" {
		t.Errorf("it says so: %+v %+v", info.Message, info.MessageText)
	}
	if info.Work[0].Jobs[0].Kind != molten.JobVitest && info.Work[1].Jobs[0].Kind != molten.JobVitest {
		t.Errorf("its jobs go with it: %+v", info.Work)
	}
	if run, _ := h.states.runOf("lead"); run.Subagents != 2 || run.State != molten.AgentStateDone {
		t.Errorf("the run counts them, whatever its prompt: %+v", run)
	}
	if other := h.info("other"); other.State != molten.AgentStateDone || other.Subagents != 0 || len(other.Work) != 0 || other.Background {
		t.Errorf("another agent of the same folder shows none that is not its own: %+v", other)
	}

	h.states.work.Set("lead", nil)
	if info := h.info("lead"); info.State != molten.AgentStateDone || info.Subagents != 0 || info.Background || len(info.Work) != 0 {
		t.Errorf("the work ends and the lead reads as it did: %+v", info)
	}
}

// A sub-agent both the hooks and the files name counts once (Claude Code's agent_id is the id of its files).
func TestLeadCountsASubagentOnceWhenHooksAndFilesNameIt(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "lead", hookMainPrompt, hookSubStart)
	h.states.work.Set("lead", []molten.SubagentWork{{Id: "a-1"}, waitingWork("a-2", molten.JobGoTest)})
	if info := h.info("lead"); info.Subagents != 2 {
		t.Errorf("a-1 is named by both and a-2 by the files: %+v", info)
	}
	h.hookRun(t, "lead", `{"hook_event_name":"SubagentStart","session_id":"s","agent_id":"a-3","agent_type":"general-purpose"}`)
	if info := h.info("lead"); info.Subagents != 3 {
		t.Errorf("a sub-agent only the hooks know yet counts too: %+v", info)
	}
}

// The ids of another agent's hooks and files are not the same (Codex): the larger of the two counts, never both.
func TestAnotherAgentsSubagentsCountAsTheLargerOfHooksAndFiles(t *testing.T) {
	h := makeAgentHarness()
	h.hookRunAs(t, "codex", "lead", hookMainPrompt, hookSubStart)
	h.states.work.Set("lead", []molten.SubagentWork{{Id: "thread-1"}, {Id: "thread-2"}})
	if info := h.info("lead"); info.Subagents != 2 {
		t.Errorf("two by the files, one by the hooks: %+v", info)
	}
}

func TestClosingAnAgentDropsItsWorkWithoutDeadlock(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "lead", hookMainPrompt, hookMainStop)
	h.states.work.Set("lead", []molten.SubagentWork{waitingWork("a-1", molten.JobTests)})
	h.states.forget("lead")
	if h.states.work.Count("lead") != 0 {
		t.Errorf("the work goes with the run: %+v", h.states.work.Get("lead"))
	}
}

// The states hold their lock while they read the registry, and the registry tells them of a change with its own
// released: the two directions meet without waiting for each other (the cycle #2501 left open).
func TestStatesAndRegistryDoNotWaitForEachOther(t *testing.T) {
	h := makeAgentHarness()
	h.hookRun(t, "lead", hookMainPrompt, hookMainStop)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			h.states.work.Set("lead", []molten.SubagentWork{waitingWork("a-1", molten.JobTests), waitingWork("a-2", molten.JobGoTest)})
			h.states.work.Set("lead", nil)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			h.states.snapshot()
			h.states.runOf("lead")
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			state := molten.AgentStateWorking
			if i%2 == 1 {
				state = molten.AgentStateDone
			}
			h.states.report(molten.AgentStateRequest{BlockId: "lead", State: state, Agent: "claude"})
		}
	}()
	wg.Wait()
}
