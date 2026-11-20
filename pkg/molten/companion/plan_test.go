// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentplan"
)

func planTestManager(path string) *Manager {
	m := MakeManager()
	m.now = func() time.Time { return time.UnixMilli(5000) }
	if path != "" {
		m.reports["block-1"] = sessionReport{agent: "claude", path: path, at: time.UnixMilli(1)}
	}
	return m
}

func applyOp(t *testing.T, m *Manager, req molten.AgentPlanRequest) agentplan.Plan {
	t.Helper()
	req.BlockId = "block-1"
	p, err := m.ApplyPlan(req)
	if err != nil {
		t.Fatalf("%s: %v", req.Op, err)
	}
	return p
}

func TestApplyPlanRunsEveryOperation(t *testing.T) {
	t.Parallel()
	m := planTestManager("/sessions/a.jsonl")
	p := applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read", "Write", "Test"}})
	if len(p.Steps) != 3 || p.UpdatedAt != 5000 {
		t.Fatalf("set = %+v", p)
	}
	p = applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpStart, Index: 2})
	p = applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpDone, Index: 1})
	p = applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpAdd, Text: "Ship"})
	if p.Current() != 2 || len(p.Steps) != 4 || p.Steps[0].Status != agentplan.StatusCompleted {
		t.Fatalf("after start, done and add = %+v", p)
	}
	shown := applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpShow})
	if len(shown.Steps) != 4 {
		t.Fatalf("show = %+v", shown)
	}
	p = applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpClear})
	if !p.Empty() {
		t.Fatalf("clear = %+v", p)
	}
}

func TestApplyPlanReportsAFailedOperationAndKeepsThePlan(t *testing.T) {
	t.Parallel()
	m := planTestManager("/sessions/a.jsonl")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})
	if _, err := m.ApplyPlan(molten.AgentPlanRequest{BlockId: "block-1", Op: agentplan.OpDone, Index: 9}); err == nil {
		t.Fatal("done of a missing step was accepted")
	}
	if _, err := m.ApplyPlan(molten.AgentPlanRequest{BlockId: "block-1", Op: "rename"}); err == nil {
		t.Fatal("an unknown operation was accepted")
	}
	shown := applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpShow})
	if len(shown.Steps) != 1 {
		t.Fatalf("the plan changed after a failed operation: %+v", shown)
	}
}

func TestApplyPlanRefusesAnEmptyBlock(t *testing.T) {
	t.Parallel()
	m := planTestManager("")
	if _, err := m.ApplyPlan(molten.AgentPlanRequest{Op: agentplan.OpShow}); err == nil {
		t.Fatal("a plan without a block was accepted")
	}
}

func TestPlanBelongsToItsSession(t *testing.T) {
	t.Parallel()
	m := planTestManager("/sessions/a.jsonl")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})
	if _, ok := m.planFor("block-1", "/sessions/a.jsonl"); !ok {
		t.Fatal("the plan is not shown for its own session")
	}
	if _, ok := m.planFor("block-1", "/sessions/b.jsonl"); ok {
		t.Fatal("the plan of one session is shown for another after /clear")
	}
	m.reports["block-1"] = sessionReport{agent: "claude", path: "/sessions/b.jsonl", at: time.UnixMilli(2)}
	fresh := applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpShow})
	if !fresh.Empty() {
		t.Fatalf("the new session starts with the old plan: %+v", fresh)
	}
}

func TestPlanPublishedBeforeASessionAppliesToTheFirstOne(t *testing.T) {
	t.Parallel()
	m := planTestManager("")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})
	if _, ok := m.planFor("block-1", "/sessions/a.jsonl"); !ok {
		t.Fatal("a plan written before any session is not shown for the first one")
	}
}

func TestForgetBlockDropsThePlan(t *testing.T) {
	t.Parallel()
	m := planTestManager("/sessions/a.jsonl")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})
	m.ForgetBlock("block-1")
	if _, ok := m.planFor("block-1", "/sessions/a.jsonl"); ok {
		t.Fatal("a closed block keeps its plan")
	}
}

// A manager that keeps the plans in dir, as the app does in its data folder, with the block's session at path.
func persistentPlanManager(dir string, path string) *Manager {
	m := planTestManager(path)
	m.planDir = dir
	return m
}

func TestPlanSurvivesARestartWhileTheSessionLives(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	before := persistentPlanManager(dir, "/sessions/a.jsonl")
	applyOp(t, before, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read", "Write"}})
	applyOp(t, before, molten.AgentPlanRequest{Op: agentplan.OpStart, Index: 1})
	applyOp(t, before, molten.AgentPlanRequest{Op: agentplan.OpDone, Index: 1})

	after := persistentPlanManager(dir, "/sessions/a.jsonl")
	shown := applyOp(t, after, molten.AgentPlanRequest{Op: agentplan.OpShow})
	if len(shown.Steps) != 2 || shown.Steps[0].Status != agentplan.StatusCompleted || shown.Steps[1].Status != agentplan.StatusPending {
		t.Fatalf("after a restart the plan is %+v", shown)
	}
	if shown.Steps[0].DoneAt != 5000 {
		t.Fatalf("the done time was lost: %+v", shown.Steps[0])
	}
}

func TestPlanOfAnotherSessionIsNotReadBack(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	applyOp(t, persistentPlanManager(dir, "/sessions/a.jsonl"), molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})
	after := persistentPlanManager(dir, "/sessions/b.jsonl")
	if _, ok := after.planFor("block-1", "/sessions/b.jsonl"); ok {
		t.Fatal("a new session read the plan of an earlier one")
	}
}

func TestPlanIsDroppedWhenTheSessionEnds(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := persistentPlanManager(dir, "/sessions/a.jsonl")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"Read"}})

	w := makeWatcher(m, "block-1")
	w.path = "/sessions/a.jsonl"
	w.noRun()

	if _, ok := persistentPlanManager(dir, "/sessions/a.jsonl").planFor("block-1", "/sessions/a.jsonl"); ok {
		t.Fatal("the plan of an ended session came back after a restart")
	}
	if _, err := os.Stat(planFileName(dir, "/sessions/a.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("the plan file of the ended session is still there: %v", err)
	}
}

func TestPlanFileHoldsOnlyItsSession(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := persistentPlanManager(dir, "/sessions/a.jsonl")
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"A"}})
	m.reports["block-1"] = sessionReport{agent: "claude", path: "/sessions/b.jsonl", at: time.UnixMilli(2)}
	applyOp(t, m, molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: []string{"B"}})
	if a, ok := readPlanFile(dir, "/sessions/a.jsonl"); !ok || a.Steps[0].Text != "A" {
		t.Fatalf("session a's file = %+v, %v", a, ok)
	}
	if b, ok := readPlanFile(dir, "/sessions/b.jsonl"); !ok || b.Steps[0].Text != "B" {
		t.Fatalf("session b's file = %+v, %v", b, ok)
	}
}

func TestChooseTasksPicksTheMostRecentSource(t *testing.T) {
	t.Parallel()
	native := []Todo{{Text: "native task", Status: TodoInProgress}}
	plan := agentplan.Plan{UpdatedAt: 200, Steps: []agentplan.Step{{Text: "published step", Status: agentplan.StatusInProgress, StartedAt: 150}}}

	todos, by, at := chooseTasks(native, 100, plan)
	if by != TasksFromPublished || at != 200 || todos[0].Text != "published step" || todos[0].At != 150 {
		t.Fatalf("plan newer than the native list: %v %d %+v", by, at, todos)
	}
	todos, by, at = chooseTasks(native, 300, plan)
	if by != TasksFromNative || at != 300 || todos[0].Text != "native task" {
		t.Fatalf("native list newer than the plan: %v %d %+v", by, at, todos)
	}
	todos, by, _ = chooseTasks(nil, 0, plan)
	if by != TasksFromPublished || len(todos) != 1 {
		t.Fatalf("no native list: %v %+v", by, todos)
	}
	todos, by, _ = chooseTasks(native, 0, agentplan.Plan{})
	if by != TasksFromNative || len(todos) != 1 {
		t.Fatalf("empty plan: %v %+v", by, todos)
	}
	todos, by, at = chooseTasks(nil, 0, agentplan.Plan{})
	if by != "" || at != 0 || todos != nil {
		t.Fatalf("nothing to show: %v %d %+v", by, at, todos)
	}
}

func TestPlanTodosCarryTheTimeOfEachStep(t *testing.T) {
	t.Parallel()
	todos := planTodos(agentplan.Plan{Steps: []agentplan.Step{
		{Text: "done", Status: agentplan.StatusCompleted, DoneAt: 10},
		{Text: "now", Status: agentplan.StatusInProgress, StartedAt: 20},
		{Text: "later", Status: agentplan.StatusPending},
	}})
	if todos[0].At != 10 || todos[1].At != 20 || todos[2].At != 0 {
		t.Fatalf("times = %d %d %d", todos[0].At, todos[1].At, todos[2].At)
	}
}
