// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentplan"
)

// The plan an agent publishes with `molten agent plan` (#2430) is kept per block, for the agent session the block
// showed when it was published: a new session (after /clear, or another run) starts with no plan. A plan published
// before any session was linked applies to the first one linked.

// must match the companion's TasksSource values in companion-model.ts
const (
	TasksFromNative    = "native"
	TasksFromPublished = "published"
)

type planEntry struct {
	session string
	plan    agentplan.Plan
	version int64
}

// ApplyPlan runs one operation of `molten agent plan` on the plan of the block's current session, and tells the
// companion of the block that it changed. Show only reads the plan.
func (m *Manager) ApplyPlan(req molten.AgentPlanRequest) (agentplan.Plan, error) {
	if req.BlockId == "" {
		return agentplan.Plan{}, fmt.Errorf("not in a MoltenTerm terminal")
	}
	report, _ := m.report(req.BlockId)
	path := report.path
	now := m.now().UnixMilli()
	current, _ := m.planFor(req.BlockId, path)
	if req.Op == agentplan.OpShow {
		return current, nil
	}
	next, err := applyPlanOp(current, req, now)
	if err != nil {
		return current, err
	}
	m.storePlan(req.BlockId, path, next)
	m.Refresh(req.BlockId)
	return next, nil
}

func applyPlanOp(p agentplan.Plan, req molten.AgentPlanRequest, now int64) (agentplan.Plan, error) {
	switch req.Op {
	case agentplan.OpSet:
		return p.Set(req.Steps, now)
	case agentplan.OpStart:
		return p.Start(req.Index, now)
	case agentplan.OpDone:
		return p.Done(req.Index, now)
	case agentplan.OpAdd:
		return p.Add(req.Text, now)
	case agentplan.OpClear:
		return p.Clear(now), nil
	}
	return p, fmt.Errorf("unknown plan operation %q", req.Op)
}

// planFor returns the plan the block's companion shows for a session path, and whether it has one. A session's plan
// the app kept on disk (before a restart) is read back when the block has none in memory.
func (m *Manager) planFor(blockId string, path string) (agentplan.Plan, bool) {
	m.lock.Lock()
	entry, ok := m.plans[blockId]
	dir := m.planDir
	m.lock.Unlock()
	if ok && (entry.session == "" || entry.session == path) {
		return entry.plan, true
	}
	if path == "" || dir == "" {
		return agentplan.Plan{}, false
	}
	plan, found := readPlanFile(dir, path)
	if !found {
		return agentplan.Plan{}, false
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	m.version++
	m.plans[blockId] = planEntry{session: path, plan: plan, version: m.version}
	return plan, true
}

func (m *Manager) storePlan(blockId string, path string, plan agentplan.Plan) {
	m.lock.Lock()
	m.version++
	m.plans[blockId] = planEntry{session: path, plan: plan, version: m.version}
	dir := m.planDir
	m.lock.Unlock()
	if path != "" && dir != "" {
		writePlanFile(dir, path, plan)
	}
}

// endPlan drops a session's plan once its agent exited: the block forgets it, and its file goes.
func (m *Manager) endPlan(blockId string, path string) {
	m.lock.Lock()
	delete(m.plans, blockId)
	dir := m.planDir
	m.lock.Unlock()
	if path != "" && dir != "" {
		removePlanFile(dir, path)
	}
}

// planDirUnder is where the plans of the agent sessions live, in MoltenTerm's data folder.
func planDirUnder(dataDir string) string {
	return filepath.Join(dataDir, "molten", "agent-plans")
}

// planFile is one session's plan on disk, named by a hash of the session's path.
type planFile struct {
	Session string         `json:"session"`
	Plan    agentplan.Plan `json:"plan"`
}

func planFileName(dir string, path string) string {
	sum := sha256.Sum256([]byte(path))
	return filepath.Join(dir, hex.EncodeToString(sum[:16])+".json")
}

func readPlanFile(dir string, path string) (agentplan.Plan, bool) {
	data, err := os.ReadFile(planFileName(dir, path))
	if err != nil {
		return agentplan.Plan{}, false
	}
	var file planFile
	if json.Unmarshal(data, &file) != nil || file.Session != path {
		return agentplan.Plan{}, false
	}
	return file.Plan, true
}

// writePlanFile replaces the session's file with the plan, through a temporary file, so a crash never leaves half of it.
func writePlanFile(dir string, path string, plan agentplan.Plan) {
	data, err := json.Marshal(planFile{Session: path, Plan: plan})
	if err != nil {
		return
	}
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	name := planFileName(dir, path)
	tmp := name + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	if os.Rename(tmp, name) != nil {
		os.Remove(tmp)
	}
}

func removePlanFile(dir string, path string) {
	os.Remove(planFileName(dir, path))
}

func (m *Manager) planVersion(blockId string) int64 {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.plans[blockId].version
}

// planTodos is the plan as the companion's task rows: a step's time is when it was done, or when it became current.
func planTodos(plan agentplan.Plan) []Todo {
	todos := make([]Todo, 0, len(plan.Steps))
	for _, s := range plan.Steps {
		todo := Todo{Text: s.Text, Status: s.Status}
		switch s.Status {
		case agentplan.StatusCompleted:
			todo.At = s.DoneAt
		case agentplan.StatusInProgress:
			todo.At = s.StartedAt
		}
		todos = append(todos, todo)
	}
	return todos
}

// chooseTasks picks the list the companion shows (#2430): the agent's native task list when the plan has no step, the
// plan when the agent keeps no native list, and otherwise whichever was updated last. It returns the list, which
// source it came from and when that source was last updated (unix ms).
func chooseTasks(native []Todo, nativeAt int64, plan agentplan.Plan) ([]Todo, string, int64) {
	published := planTodos(plan)
	switch {
	case len(published) == 0 && len(native) == 0:
		return nil, "", 0
	case len(published) == 0:
		return native, TasksFromNative, nativeAt
	case len(native) == 0:
		return published, TasksFromPublished, plan.UpdatedAt
	case plan.UpdatedAt > nativeAt:
		return published, TasksFromPublished, plan.UpdatedAt
	}
	return native, TasksFromNative, nativeAt
}
