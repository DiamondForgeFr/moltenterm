// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
	"github.com/wavetermdev/waveterm/pkg/molten/agentplan"
)

func TestMoltenAgentPlanSubcommandsAreRegistered(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"set", "start", "done", "add", "clear", "show"} {
		found, _, err := moltenAgentCmd.Find([]string{"plan", name})
		if err != nil || found == nil || found.Name() != name {
			t.Fatalf("molten agent plan %s: %v %v", name, found, err)
		}
	}
}

func TestMoltenPlanIndexStartsAtOne(t *testing.T) {
	t.Parallel()
	if n, err := moltenPlanIndex("3"); err != nil || n != 3 {
		t.Fatalf("3 = %d, %v", n, err)
	}
	for _, bad := range []string{"0", "-1", "two", ""} {
		if _, err := moltenPlanIndex(bad); err == nil {
			t.Errorf("%q was accepted as a step number", bad)
		}
	}
}

func TestFormatMoltenPlanSaysWhatChanged(t *testing.T) {
	t.Parallel()
	plan := agentplan.Plan{Steps: []agentplan.Step{
		{Text: "Read", Status: agentplan.StatusCompleted, DoneAt: 1},
		{Text: "Write", Status: agentplan.StatusInProgress, StartedAt: 2},
		{Text: "Test", Status: agentplan.StatusPending},
	}}
	cases := map[string]struct {
		req  molten.AgentPlanRequest
		want string
	}{
		"start": {molten.AgentPlanRequest{Op: agentplan.OpStart, Index: 2}, "Step 2 is in progress: Write."},
		"done":  {molten.AgentPlanRequest{Op: agentplan.OpDone, Index: 2}, "Step 2 is done: Write (1 of 3 done)."},
		"add":   {molten.AgentPlanRequest{Op: agentplan.OpAdd}, "Step 3 added: Test."},
		"clear": {molten.AgentPlanRequest{Op: agentplan.OpClear}, "Plan cleared."},
		"set":   {molten.AgentPlanRequest{Op: agentplan.OpSet}, "Plan set: 3 steps, all to do."},
		"show":  {molten.AgentPlanRequest{Op: agentplan.OpShow}, "Plan: 1 of 3 steps done.\n1. [x] Read\n2. [>] Write\n3. [ ] Test"},
	}
	for name, c := range cases {
		if got := formatMoltenPlan(c.req, plan); got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", name, got, c.want)
		}
	}
}

// #2585: the hook adds --subagent after the operation, and cobra reads it there and before it.
// It parses into the command's package variable, so it does not run in parallel with another test that does.
func TestMoltenAgentPlanTakesTheSubagentFlagAnywhere(t *testing.T) {
	t.Cleanup(func() { moltenAgentPlanSubagent = "" })
	for _, args := range [][]string{
		{"plan", "done", "--subagent", "a4e9", "3"},
		{"plan", "--subagent", "a4e9", "done", "3"},
		{"plan", "done", "3", "--subagent=a4e9"},
	} {
		moltenAgentPlanSubagent = ""
		found, rest, err := moltenAgentCmd.Find(args)
		if err != nil || found == nil || found.Name() != "done" {
			t.Fatalf("%v: %v %v", args, found, err)
		}
		if err := found.ParseFlags(rest); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if moltenAgentPlanSubagent != "a4e9" || len(found.Flags().Args()) != 1 || found.Flags().Arg(0) != "3" {
			t.Fatalf("%v: subagent %q, args %v", args, moltenAgentPlanSubagent, found.Flags().Args())
		}
	}
}

func TestFormatMoltenPlanTellsASubagentItsPlanIsItsOwn(t *testing.T) {
	t.Parallel()
	plan := agentplan.Plan{Subagent: "a4e9", Steps: []agentplan.Step{{Text: "Read", Status: agentplan.StatusPending}}}
	got := formatMoltenPlan(molten.AgentPlanRequest{Op: agentplan.OpSet, Subagent: "a4e9"}, plan)
	if got != "Plan set: 1 step, all to do.\n"+moltenSubagentPlanNote {
		t.Fatalf("sub-agent set = %q", got)
	}
	if got := formatMoltenPlan(molten.AgentPlanRequest{Op: agentplan.OpSet}, agentplan.Plan{Steps: plan.Steps}); strings.Contains(got, "sub-agent") {
		t.Fatalf("the lead is told it is a sub-agent: %q", got)
	}
}

// The small molten program cannot import agentplan: its copy of the id rule must agree.
func TestSubagentIdRulesAgree(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"a4e95569a24e07cb3", "019a0000-1111-7222-8333-444455556666", "a_b", "", "a b", "a;b", "$(x)", "é", strings.Repeat("a", 128), strings.Repeat("a", 129)} {
		if agentplan.ValidSubagentId(id) != agenthook.ValidSubagentId(id) {
			t.Errorf("%q: agentplan %v, agenthook %v", id, agentplan.ValidSubagentId(id), agenthook.ValidSubagentId(id))
		}
	}
}

func TestFormatMoltenPlanShowsAnEmptyPlan(t *testing.T) {
	t.Parallel()
	got := formatMoltenPlan(molten.AgentPlanRequest{Op: agentplan.OpShow}, agentplan.Plan{})
	if !strings.HasPrefix(got, "The plan is empty.") {
		t.Fatalf("empty plan = %q", got)
	}
}
