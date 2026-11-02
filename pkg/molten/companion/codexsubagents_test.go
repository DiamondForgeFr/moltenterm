// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Synthetic rollouts in the shapes codex-cli writes for its sub-agents (#986): the parent's spawn_agent calls and
// SubAgentActivity items, each sub-agent's own rollout with its thread_spawn header.
const (
	codexSubParent   = "01a164eb-eca9-7861-93c2-000000000001"
	codexSubReliable = "01a164ec-d6f1-7d60-878b-000000000002"
	codexSubUx       = "01a164ec-efd6-7233-8d66-000000000003"
	codexSubNested   = "01a164ed-0000-7000-8000-000000000004"
	// What a spawn's encrypted message looks like: it must never reach a view.
	codexSubSecret = "gAAAAABsecretEncryptedPayload=="
)

func codexStamp(at time.Time) string {
	return at.UTC().Format(time.RFC3339Nano)
}

func codexSpawnCall(at time.Time, callId string, task string, role string, extra string) string {
	args := fmt.Sprintf(`{"task_name":%q,"agent_type":%q,"message":%q%s}`, task, role, codexSubSecret, extra)
	return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","namespace":"collaboration","arguments":%q,"call_id":%q}}`,
		codexStamp(at), args, callId)
}

func codexSpawnOutput(at time.Time, callId string, path string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call_output","call_id":%q,"output":%q}}`,
		codexStamp(at), callId, fmt.Sprintf(`{"task_name":%q}`, path))
}

func codexActivity(at time.Time, id string, kind string, thread string, path string, settings string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"item_completed","thread_id":%q,"item":{"type":"SubAgentActivity"%s,"id":%q,"kind":%q,"agent_thread_id":%q,"agent_path":%q}}}`,
		codexStamp(at), codexSubParent, settings, id, kind, thread, path)
}

func codexSubMeta(id string, parent string, depth int, path string, nickname string, role string, cwd string, at time.Time) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"cli_version":"0.170.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":%q,"depth":%d,"agent_path":%q,"agent_nickname":%q,"agent_role":%q}}},"thread_source":"subagent","parent_thread_id":%q}}`,
		codexStamp(at), id, codexStamp(at), cwd, parent, depth, path, nickname, role, parent)
}

func codexTurnEvent(at time.Time, kind string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":%q,"turn_id":"t"}}`, codexStamp(at), kind)
}

func codexSubTurnContext(cwd string, model string, effort string) string {
	return fmt.Sprintf(`{"timestamp":"2026-10-22T18:43:26Z","type":"turn_context","payload":{"turn_id":"t","cwd":%q,"model":%q,"effort":%q}}`, cwd, model, effort)
}

type codexSubFixture struct {
	root     string
	repo     string
	reliable string
	ux       string
	parent   string
}

// makeCodexSubFixture: a parent on develop spawns audit_reliability (explorer, in a worktree on fix/961-…) and audit_ux
// (worker, on feature/960-…), which completed; audit_reliability started a sub-agent of its own (depth 2).
func makeCodexSubFixture(t *testing.T) codexSubFixture {
	t.Helper()
	f := codexSubFixture{root: t.TempDir(), repo: t.TempDir()}
	makeRepo(t, f.repo, "develop")
	f.reliable = filepath.Join(f.repo, ".codex", "worktrees", "reliability")
	makeWorktree(t, f.repo, f.reliable, "fix/961-status-bar-detached-head")
	f.ux = filepath.Join(f.repo, ".codex", "worktrees", "ux")
	makeWorktree(t, f.repo, f.ux, "feature/960-merged-history")
	now := time.Now().Add(-10 * time.Minute)
	f.parent = codexRolloutPath(f.root, now, codexSubParent)
	writeCodexLines(t, f.parent,
		codexMeta(codexSubParent, f.repo, now, ""),
		codexTurnEvent(now, "task_started"),
		codexUserMessage(now, "Audit the project with two agents"),
		codexSpawnCall(now.Add(time.Second), "call_rel", "audit_reliability", "explorer", ""),
		codexSpawnOutput(now.Add(time.Second), "call_rel", "/root/audit_reliability"),
		codexActivity(now.Add(time.Second), "call_rel", "started", codexSubReliable, "/root/audit_reliability", `,"model":"gpt-6-astra","reasoning_effort":"high"`),
		codexSpawnCall(now.Add(2*time.Second), "call_ux", "audit_ux", "worker", `,"model":"gpt-6.1-sol","reasoning_effort":"low"`),
		codexSpawnOutput(now.Add(2*time.Second), "call_ux", "/root/audit_ux"),
		codexActivity(now.Add(2*time.Second), "call_ux", "started", codexSubUx, "/root/audit_ux", `,"model":"gpt-6.1-sol","reasoning_effort":"low"`),
		codexActivity(now.Add(3*time.Minute), "subagent-completed-x", "completed", codexSubUx, "/root/audit_ux", `,"model":null,"reasoning_effort":null`),
	)
	writeCodexLines(t, codexRolloutPath(f.root, now.Add(time.Second), codexSubReliable),
		codexSubMeta(codexSubReliable, codexSubParent, 1, "/root/audit_reliability", "Nash", "explorer", f.repo, now.Add(time.Second)),
		codexMeta(codexSubParent, f.repo, now, ""),
		codexTurnEvent(now.Add(time.Second), "task_started"),
		codexSubTurnContext(f.reliable, "gpt-6-astra", "high"),
	)
	writeCodexLines(t, codexRolloutPath(f.root, now.Add(2*time.Second), codexSubUx),
		codexSubMeta(codexSubUx, codexSubParent, 1, "/root/audit_ux", "Bohr", "worker", f.ux, now.Add(2*time.Second)),
		codexTurnEvent(now.Add(2*time.Second), "task_started"),
		codexSubTurnContext(f.ux, "gpt-6.1-sol", "low"),
		codexTurnEvent(now.Add(3*time.Minute), "task_complete"),
	)
	writeCodexLines(t, codexRolloutPath(f.root, now.Add(time.Minute), codexSubNested),
		codexSubMeta(codexSubNested, codexSubReliable, 2, "/root/audit_reliability/check_guards", "Kant", "", f.reliable, now.Add(time.Minute)),
		codexTurnEvent(now.Add(time.Minute), "task_started"),
	)
	// A reviewer names the session as its parent, with no place in the agents' tree: never listed.
	writeCodexLines(t, codexRolloutPath(f.root, now.Add(time.Minute), "01a164ed-0000-7000-8000-000000000005"),
		fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":"01a164ed-0000-7000-8000-000000000005","cwd":%q,"source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review","parent_thread_id":%q}}`, codexStamp(now), f.repo, codexSubReliable),
	)
	return f
}

func subagentsByName(subs []SubagentInfo) map[string]SubagentInfo {
	rtn := map[string]SubagentInfo{}
	for _, sub := range subs {
		rtn[sub.Description] = sub
	}
	return rtn
}

func TestCodexSubagentsFromRollouts(t *testing.T) {
	f := makeCodexSubFixture(t)
	a := MakeCodexAdapter([]string{f.root})
	s := MakeSession()
	parsePath(t, a, s, f.parent)
	subs := subagentsByName(s.Subagents())
	if len(subs) != 2 {
		t.Fatalf("two sub-agents from the parent's rollout: %+v", s.Subagents())
	}
	rel, ux := subs["audit reliability"], subs["audit ux"]
	if rel.Kind != "explorer" || rel.State != SubagentRunning || !rel.Background || rel.Model != "gpt-6-astra" || rel.Effort != "high" {
		t.Errorf("audit_reliability: %+v", rel)
	}
	if ux.Kind != "worker" || ux.State != SubagentDone || ux.Model != "gpt-6.1-sol" || ux.Effort != "low" {
		t.Errorf("audit_ux, completed: %+v", ux)
	}
	for _, call := range s.pending {
		if strings.Contains(call.Args, codexSubSecret) {
			t.Errorf("the encrypted message reached a tool call: %+v", call)
		}
	}

	// What a refresh does (readSubagents): the nested agent, then each running agent's own rollout.
	for _, found := range a.FindSubagents(f.parent, []string{codexSubReliable}, rel.Started) {
		s.AddFoundSubagent(found)
	}
	for _, sa := range s.runningSubagents() {
		if facts, ok := a.ReadSubagent(f.parent, sa.agentId); ok {
			s.SetSubagentFacts(sa.callId, facts)
		}
	}
	s.ResolveTickets(nil)
	subs = subagentsByName(s.Subagents())
	if len(subs) != 3 {
		t.Fatalf("the nested agent listed, the reviewer not: %+v", s.Subagents())
	}
	rel = subs["audit reliability"]
	if rel.Branch != "fix/961-status-bar-detached-head" || rel.Ticket != 961 || rel.State != SubagentRunning {
		t.Errorf("audit_reliability's branch and ticket from its own folder: %+v", rel)
	}
	nested := subs["check guards"]
	if nested.State != SubagentRunning || nested.Branch != "fix/961-status-bar-detached-head" || !nested.Background {
		t.Errorf("the nested agent: %+v", nested)
	}
	for _, sub := range s.Subagents() {
		if strings.Contains(fmt.Sprintf("%+v", sub), codexSubSecret) {
			t.Errorf("the encrypted message reached a sub-agent: %+v", sub)
		}
	}
	if w := a.SubagentWritten(f.parent, codexSubUx); w == 0 {
		t.Errorf("audit_ux's rollout write time")
	}

	// The nested agent ends its turn: its own rollout says so.
	nestedPath := codexRolloutPath(f.root, time.UnixMilli(nested.Started), codexSubNested)
	data, _ := os.ReadFile(nestedPath)
	writeCodexLines(t, nestedPath, strings.TrimSpace(string(data)), codexTurnEvent(time.Now(), "task_complete"))
	for _, sa := range s.runningSubagents() {
		if facts, ok := a.ReadSubagent(f.parent, sa.agentId); ok {
			s.SetSubagentFacts(sa.callId, facts)
		}
	}
	if got := subagentsByName(s.Subagents()); got["check guards"].State != SubagentDone || got["audit reliability"].State != SubagentRunning {
		t.Errorf("the nested agent done, its recorded parent still running (its end comes from the parent's records): %+v", s.Subagents())
	}
}

// A follow-up sends a completed agent back to work; an interrupted one stops; an activity without a recorded call
// starts its agent from its path.
func TestCodexSubagentFollowUpAndInterrupt(t *testing.T) {
	a := MakeCodexAdapter([]string{t.TempDir()})
	s := MakeSession()
	now := time.Now()
	parseLines(t, a, s,
		codexMeta(codexSubParent, "/tmp", now, ""),
		codexActivity(now, "call_a", "started", codexSubReliable, "/root/implement_812", ""),
		codexActivity(now, "subagent-completed-1", "completed", codexSubReliable, "/root/implement_812", ""),
	)
	sub := s.Subagents()
	if len(sub) != 1 || sub[0].Description != "implement 812" || sub[0].State != SubagentDone || sub[0].Ended == 0 {
		t.Fatalf("started from its activity, then completed: %+v", sub)
	}
	parseLines(t, a, s, codexActivity(now.Add(time.Minute), "call_b", "interacted", codexSubReliable, "/root/implement_812", ""))
	if sub = s.Subagents(); sub[0].State != SubagentRunning || sub[0].Ended != 0 {
		t.Fatalf("a follow-up wakes it: %+v", sub)
	}
	// A woken agent counts from its follow-up, not from its start, before it is quiet.
	if s.QuietSubagents(now.Add(time.Minute).Add(SubagentQuietAfter).UnixMilli()-1, nil) {
		t.Errorf("quiet too early: %+v", s.Subagents())
	}
	parseLines(t, a, s, codexActivity(now.Add(2*time.Minute), "call_c", "interrupted", codexSubReliable, "/root/implement_812", ""))
	if sub = s.Subagents(); sub[0].State != SubagentStopped {
		t.Fatalf("interrupted: %+v", sub)
	}
}

func codexExecCall(at time.Time, callId string, cmd string, workdir string) string {
	args := fmt.Sprintf(`{"cmd":%q,"workdir":%q,"yield_time_ms":10000}`, cmd, workdir)
	return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":%q,"call_id":%q}}`,
		codexStamp(at), args, callId)
}

// #1463: Codex starts a sub-agent in its parent's folder, so its turns' cwd stays the main checkout while it runs its
// commands in its ticket's worktree. Its folder, branch and ticket are the worktree's; commands in a subfolder of the
// main checkout or outside any repository do not move it; a sub-agent whose commands all run in the main checkout
// stays there.
func TestCodexSubagentWorksWhereItsCommandsRun(t *testing.T) {
	root, repo, outside := t.TempDir(), t.TempDir(), t.TempDir()
	makeRepo(t, repo, "develop")
	tree := filepath.Join(t.TempDir(), "mt-1462")
	makeWorktree(t, repo, tree, "fix/1462-codex-sessions")
	now := time.Now().Add(-5 * time.Minute)
	parent := codexRolloutPath(root, now, codexSubParent)
	writeCodexLines(t, parent,
		codexMeta(codexSubParent, repo, now, ""),
		codexTurnEvent(now, "task_started"),
		codexSpawnCall(now.Add(time.Second), "call_rel", "ticket_1462", "worker", ""),
		codexSpawnOutput(now.Add(time.Second), "call_rel", "/root/ticket_1462"),
		codexActivity(now.Add(time.Second), "call_rel", "started", codexSubReliable, "/root/ticket_1462", `,"model":"gpt-5.5","reasoning_effort":"high"`),
		codexSpawnCall(now.Add(2*time.Second), "call_ux", "read_docs", "explorer", ""),
		codexSpawnOutput(now.Add(2*time.Second), "call_ux", "/root/read_docs"),
		codexActivity(now.Add(2*time.Second), "call_ux", "started", codexSubUx, "/root/read_docs", ""),
	)
	writeCodexLines(t, codexRolloutPath(root, now.Add(time.Second), codexSubReliable),
		codexSubMeta(codexSubReliable, codexSubParent, 1, "/root/ticket_1462", "Nash", "worker", repo, now.Add(time.Second)),
		codexTurnEvent(now.Add(time.Second), "task_started"),
		codexSubTurnContext(repo, "gpt-5.5", "high"),
		codexExecCall(now.Add(2*time.Second), "c1", "go test ./pkg/...", tree),
		codexExecCall(now.Add(3*time.Second), "c2", "ls", "frontend"),
		codexExecCall(now.Add(4*time.Second), "c3", "ls", outside),
	)
	writeCodexLines(t, codexRolloutPath(root, now.Add(2*time.Second), codexSubUx),
		codexSubMeta(codexSubUx, codexSubParent, 1, "/root/read_docs", "Bohr", "explorer", repo, now.Add(2*time.Second)),
		codexTurnEvent(now.Add(2*time.Second), "task_started"),
		codexSubTurnContext(repo, "gpt-5.5", "low"),
		codexExecCall(now.Add(3*time.Second), "d1", "cat README.md", repo),
	)
	a := MakeCodexAdapter([]string{root})

	ids := map[string]SubagentIdentity{}
	for _, id := range a.ListSubagents(parent) {
		ids[id.Description] = id
	}
	if got := ids["ticket 1462"]; got.Worktree != tree || got.Model != "gpt-5.5" || got.Finished {
		t.Errorf("Integration's listing: the sub-agent works in its commands' worktree: %+v", got)
	}
	if got := ids["read docs"]; got.Worktree != repo {
		t.Errorf("a sub-agent whose commands run in the main checkout stays there: %+v", got)
	}

	s := MakeSession()
	parsePath(t, a, s, parent)
	for _, sa := range s.runningSubagents() {
		if facts, ok := a.ReadSubagent(parent, sa.agentId); ok {
			s.SetSubagentFacts(sa.callId, facts)
		}
	}
	s.ResolveTickets(nil)
	subs := subagentsByName(s.Subagents())
	if got := subs["ticket 1462"]; got.Branch != "fix/1462-codex-sessions" || got.Ticket != 1462 {
		t.Errorf("the companion's row: the worktree's branch and ticket, not the main checkout's: %+v", got)
	}
	if got := subs["read docs"]; got.Branch != "develop" || got.Ticket != 0 {
		t.Errorf("the main checkout's sub-agent: %+v", got)
	}
}

// The companion of a Codex pane shows its sub-agents, their tickets read on a refresh.
func TestCodexSubagentsInCompanion(t *testing.T) {
	f := makeCodexSubFixture(t)
	m, env := makeCodexLinkManager(t, f.root)
	labels := &fakeLabels{calls: map[int]int{}, labels: map[int][]string{961: {"complexity: bug"}}}
	m.ticketLabels = labels.lookup
	env.lock.Lock()
	env.runs["b"] = molten.AgentRunInfo{BlockId: "b", Agent: molten.AgentIdCodex, Started: time.Now().Add(-time.Hour).UnixMilli(), Running: true}
	env.cwds["b"] = f.repo
	env.lock.Unlock()
	defer m.Close("b", "v")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: molten.AgentIdCodex, Path: f.parent}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool { return len(v.Subagents) == 2 })
	m.Refresh("b")
	v := waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool {
		subs := subagentsByName(v.Subagents)
		return len(v.Subagents) == 3 && subs["audit reliability"].Ticket == 961
	})
	subs := subagentsByName(v.Subagents)
	if subs["audit ux"].State != SubagentDone || subs["check guards"].State != SubagentRunning {
		t.Errorf("states: %+v", v.Subagents)
	}
}
