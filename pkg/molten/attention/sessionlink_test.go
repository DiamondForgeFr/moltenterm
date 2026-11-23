// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// #2474: the session the run reports is kept from its own hooks, only from the block's own local terminal, only for the
// main session; a new run, or a new agent, starts with none, so an autonomous mode is never checked against a past one.
func TestRunKnowsTheSessionItsHooksReport(t *testing.T) {
	h := makeAgentHarness()
	own := localroute.Caller{IsLocalTerminal: true, BlockId: "b1"}
	req := molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: molten.AgentIdClaude, SessionId: "s-1"}
	if _, _, err := h.states.report(req); err != nil {
		t.Fatal(err)
	}
	if run, _ := h.states.runOf("b1"); run.SessionId != "" {
		t.Fatalf("the session is known before its hook said it: %q", run.SessionId)
	}
	h.states.noteSession(own, req)
	if run, ok := h.states.runOf("b1"); !ok || run.SessionId != "s-1" {
		t.Fatalf("run %+v", run)
	}
	if all := h.states.allRuns(); len(all) != 1 || all[0].SessionId != "s-1" {
		t.Fatalf("all runs %+v", all)
	}

	for name, c := range map[string]struct {
		caller localroute.Caller
		edit   func(r *molten.AgentStateRequest)
	}{
		"another terminal":      {localroute.Caller{IsLocalTerminal: true, BlockId: "b2"}, nil},
		"a token without block": {localroute.Caller{IsLocalTerminal: true}, nil},
		"a window":              {localroute.Caller{IsWindow: true}, nil},
		"a remote terminal":     {localroute.Caller{BlockId: "b1"}, nil},
		"a sub-agent":           {own, func(r *molten.AgentStateRequest) { r.Subagent = "a1" }},
		"another agent":         {own, func(r *molten.AgentStateRequest) { r.Agent = molten.AgentIdCodex }},
		"no session":            {own, func(r *molten.AgentStateRequest) { r.SessionId = "" }},
	} {
		r := req
		r.SessionId = "s-other"
		if c.edit != nil {
			c.edit(&r)
		}
		h.states.noteSession(c.caller, r)
		if run, _ := h.states.runOf("b1"); run.SessionId != "s-1" {
			t.Errorf("%s: the session became %q", name, run.SessionId)
		}
	}

	req.SessionId = "s-2"
	h.states.noteSession(own, req)
	if run, _ := h.states.runOf("b1"); run.SessionId != "s-2" {
		t.Fatalf("the agent's new session (/clear, /resume) is not followed: %q", run.SessionId)
	}

	// A new agent in the terminal is a new run: it starts with no session.
	if _, _, err := h.states.report(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: molten.AgentIdCodex}); err != nil {
		t.Fatal(err)
	}
	if run, _ := h.states.runOf("b1"); run.Agent != molten.AgentIdCodex || run.SessionId != "" {
		t.Fatalf("a new agent kept the session of the one before: %+v", run)
	}

	// The record of a run that ended is gone, and so is its session.
	h.states.forgetRecord("b1")
	if run, ok := h.states.runOf("b1"); ok || run.SessionId != "" {
		t.Fatalf("the ended run still has a session: %+v", run)
	}
	h.states.noteSession(own, req)
	if _, ok := h.states.runOf("b1"); ok {
		t.Fatal("a report with no run made one")
	}
}
