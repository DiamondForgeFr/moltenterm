// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
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

func TestFormatMoltenPlanShowsAnEmptyPlan(t *testing.T) {
	t.Parallel()
	got := formatMoltenPlan(molten.AgentPlanRequest{Op: agentplan.OpShow}, agentplan.Plan{})
	if !strings.HasPrefix(got, "The plan is empty.") {
		t.Fatalf("empty plan = %q", got)
	}
}
