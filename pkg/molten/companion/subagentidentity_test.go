// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const claudeIdentitySession = "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6"

type claudeIdentityFixture struct {
	root    string
	session string
	subs    string
	running string
	done    string
}

// makeClaudeIdentityFixture: a parent session whose two background worktree agents' meta files say their task and
// worktree, one running (#1033) and one finished (#1029), with transcripts naming their model.
func makeClaudeIdentityFixture(t *testing.T) claudeIdentityFixture {
	t.Helper()
	f := claudeIdentityFixture{root: t.TempDir()}
	repo := t.TempDir()
	f.running = filepath.Join(repo, ".claude", "worktrees", "agent-a34d")
	f.done = filepath.Join(repo, ".claude", "worktrees", "agent-b56e")
	project := filepath.Join(f.root, ClaudeSlug(repo))
	f.subs = filepath.Join(project, claudeIdentitySession, "subagents")
	if err := os.MkdirAll(f.subs, 0o700); err != nil {
		t.Fatal(err)
	}
	f.session = filepath.Join(project, claudeIdentitySession+".jsonl")
	writeLines(t, f.session, fmt.Sprintf(`{"type":"user","cwd":%q,"message":{"role":"user","content":"go"}}`, repo))
	writeLines(t, filepath.Join(f.subs, "agent-a34d.meta.json"),
		fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"worktreeBranch":"worktree-agent-a34d","description":"#1033 agent name in tabs","spawnDepth":1,"requestShape":"background"}`, f.running))
	writeLines(t, filepath.Join(f.subs, "agent-a34d.jsonl"),
		fmt.Sprintf(`{"type":"assistant","cwd":%q,"message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"secret work"}]}}`, f.running),
		`{"type":"assistant","message":{"model":"<synthetic>"}}`)
	writeLines(t, filepath.Join(f.subs, "agent-b56e.meta.json"),
		fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"#1029 release notes","finished":true}`, f.done))
	writeLines(t, filepath.Join(f.subs, "agent-b56e.jsonl"),
		`{"type":"assistant","message":{"model":"claude-sonnet-5"}}`)
	writeLines(t, filepath.Join(f.subs, "agent-bad id.meta.json"), `{"description":"never read"}`)
	return f
}

func identitiesById(ids []SubagentIdentity) map[string]SubagentIdentity {
	rtn := map[string]SubagentIdentity{}
	for _, id := range ids {
		rtn[id.AgentId] = id
	}
	return rtn
}

func TestClaudeListSubagents(t *testing.T) {
	f := makeClaudeIdentityFixture(t)
	a := MakeClaudeAdapter([]string{f.root})
	now := time.Now()
	ids := identitiesById(ApplyHookSubagents(a.ListSubagents(f.session), nil, now))
	if len(ids) != 2 {
		t.Fatalf("want 2 sub-agents, got %+v", ids)
	}
	run := ids["a34d"]
	if run.Description != "#1033 agent name in tabs" || run.Kind != "general-purpose" || run.Model != "claude-opus-5-5" || run.Worktree != f.running {
		t.Errorf("running agent: %+v", run)
	}
	if run.State != SubagentRunning || run.LastWrite == 0 {
		t.Errorf("running agent state: %+v", run)
	}
	done := ids["b56e"]
	if done.Description != "#1029 release notes" || done.Model != "claude-sonnet-5" || done.Worktree != f.done || done.State != SubagentDone {
		t.Errorf("finished agent: %+v", done)
	}
	// A long silence is quiet, never working.
	later := ApplyHookSubagents(a.ListSubagents(f.session), nil, now.Add(SubagentQuietAfter+time.Minute))
	if got := identitiesById(later)["a34d"].State; got != SubagentQuiet {
		t.Errorf("silent agent: %q", got)
	}
	// ReadSubagent (the companion's and the Now card's) reads the same folder.
	facts, ok := a.ReadSubagent(f.session, "a34d")
	if !ok || facts.Worktree != f.running || facts.Model != "claude-opus-5-5" {
		t.Errorf("ReadSubagent: %+v", facts)
	}
}

func TestApplyHookSubagents(t *testing.T) {
	now := time.Now()
	ids := []SubagentIdentity{
		{AgentId: "a1", LastWrite: now.Add(-time.Minute).UnixMilli()},
		{AgentId: "a2", LastWrite: now.Add(-time.Minute).UnixMilli()},
		{AgentId: "a3"},
	}
	stop := now.Add(-2 * time.Minute).UnixMilli()
	hooks := []SubagentHookEvent{
		{AgentSubagentRequest: molten.AgentSubagentRequest{Event: molten.SubagentEventStart, AgentId: "a1"}, At: stop - 1000},
		{AgentSubagentRequest: molten.AgentSubagentRequest{Event: molten.SubagentEventStop, AgentId: "a1"}, At: stop},
		{AgentSubagentRequest: molten.AgentSubagentRequest{Event: molten.SubagentEventStop, AgentId: "a2"}, At: stop - 5000},
		{AgentSubagentRequest: molten.AgentSubagentRequest{Event: molten.SubagentEventStart, AgentId: "a2"}, At: stop},
	}
	got := identitiesById(ApplyHookSubagents(ids, hooks, now))
	if got["a1"].State != SubagentDone || got["a1"].LastWrite != stop {
		t.Errorf("a stop ends the agent at its time: %+v", got["a1"])
	}
	if got["a2"].State != SubagentRunning {
		t.Errorf("a start after the stop runs it again: %+v", got["a2"])
	}
	if got["a3"].State != SubagentRunning {
		t.Errorf("nothing known: running: %+v", got["a3"])
	}
}

func TestHookSessionPath(t *testing.T) {
	f := makeClaudeIdentityFixture(t)
	a := MakeClaudeAdapter([]string{f.root})
	stop := SubagentHookEvent{AgentSubagentRequest: molten.AgentSubagentRequest{
		Event: molten.SubagentEventStop, AgentId: "b56e", TranscriptPath: filepath.Join(f.subs, "agent-b56e.jsonl"),
	}}
	got := hookSessionPath(a, []SubagentHookEvent{stop})
	want, _ := filepath.EvalSymlinks(f.session)
	if got != want {
		t.Errorf("parent session: %q, want %q", got, want)
	}
	outside := t.TempDir()
	os.MkdirAll(filepath.Join(outside, "s", "subagents"), 0o700)
	writeLines(t, filepath.Join(outside, "s.jsonl"), "{}")
	stop.TranscriptPath = filepath.Join(outside, "s", "subagents", "agent-x.jsonl")
	if got := hookSessionPath(a, []SubagentHookEvent{stop}); got != "" {
		t.Errorf("a session outside the roots is never read: %q", got)
	}
}

func TestPaneSubagentsFromHooks(t *testing.T) {
	f := makeClaudeIdentityFixture(t)
	m := MakeManager()
	m.adapterFor = func(agent string) Adapter {
		if agent == molten.AgentIdClaude {
			return MakeClaudeAdapter([]string{f.root})
		}
		return nil
	}
	hooks := []SubagentHookEvent{{AgentSubagentRequest: molten.AgentSubagentRequest{
		BlockId: "b1", Agent: molten.AgentIdClaude, Event: molten.SubagentEventStop, AgentId: "b56e",
		TranscriptPath: filepath.Join(f.subs, "agent-b56e.jsonl"),
	}, At: time.Now().UnixMilli()}}
	ids := identitiesById(m.PaneSubagents("b1", hooks))
	if len(ids) != 2 || ids["a34d"].Worktree != f.running || ids["b56e"].State != SubagentDone {
		t.Errorf("sub-agents from the hook's session: %+v", ids)
	}
	if got := m.PaneSubagents("b2", nil); got != nil {
		t.Errorf("no session, no hooks: %+v", got)
	}
}

func TestCodexListSubagents(t *testing.T) {
	f := makeCodexSubFixture(t)
	a := MakeCodexAdapter([]string{f.root})
	ids := ApplyHookSubagents(a.ListSubagents(f.parent), nil, time.Now())
	byName := map[string]SubagentIdentity{}
	for _, id := range ids {
		byName[id.Description] = id
	}
	if len(byName) != 2 {
		t.Fatalf("want the session's 2 own sub-agents, got %+v", ids)
	}
	rel := byName["audit reliability"]
	if rel.Kind != "explorer" || rel.Model != "gpt-6-astra" || rel.Worktree != f.reliable || rel.State != SubagentRunning {
		t.Errorf("running agent: %+v", rel)
	}
	ux := byName["audit ux"]
	if ux.Model != "gpt-6.1-sol" || ux.Worktree != f.ux || ux.State != SubagentDone {
		t.Errorf("finished agent: %+v", ux)
	}
}
