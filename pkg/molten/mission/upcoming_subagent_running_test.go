// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// #2397: Claude Code starts a worktree sub-agent on worktree-agent-<id> (the branch its meta file keeps) and the agent
// then checks out its ticket's branch. Its upcoming row names the sub-agent while it runs, even after a SubagentStop
// its own background work or a SendMessage resume outlived; a finished one is not at work.
func TestUpcomingRunningSubagentOnRenamedBranch(t *testing.T) {
	t.Parallel()
	dir := makeGitFlowRepo(t)
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}","fix":"fix/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	running := filepath.Join(dir, ".claude", "worktrees", "agent-c78f")
	finished := filepath.Join(dir, ".claude", "worktrees", "agent-d90a")
	gitRun(t, dir, "worktree", "add", "-q", "-b", "worktree-agent-c78f", running, "develop")
	gitRun(t, dir, "worktree", "add", "-q", "-b", "worktree-agent-d90a", finished, "develop")
	gitRun(t, running, "checkout", "-q", "-b", "fix/9201-renamed-branch")
	gitRun(t, finished, "checkout", "-q", "-b", "fix/9202-finished")
	commit(t, running, "a.txt", "fix: a")
	commit(t, finished, "b.txt", "fix: b")

	root := t.TempDir()
	sessionId := "7b1d4f3a-2c3e-4d5f-9a01-b2c3d4e5f6a7"
	session := filepath.Join(root, companion.ClaudeSlug(dir), sessionId+".jsonl")
	subs := filepath.Join(filepath.Dir(session), sessionId, "subagents")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	write := func(path string, text string, when time.Time) {
		if err := os.WriteFile(path, []byte(text+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}
	write(session, `{"type":"user"}`, now)
	write(filepath.Join(subs, "agent-c78f.meta.json"), fmt.Sprintf(`{"agentType":"sf-fix","worktreePath":%q,"worktreeBranch":"worktree-agent-c78f","description":"#9201 renamed branch","toolUseId":"toolu_c78f","requestShape":"background"}`, running), now.Add(-time.Hour))
	write(filepath.Join(subs, "agent-c78f.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`, now.Add(-time.Minute))
	write(filepath.Join(subs, "agent-d90a.meta.json"), fmt.Sprintf(`{"agentType":"sf-fix","worktreePath":%q,"worktreeBranch":"worktree-agent-d90a","description":"#9202 finished","toolUseId":"toolu_d90a","finished":true}`, finished), now.Add(-20*time.Minute))
	write(filepath.Join(subs, "agent-d90a.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`, now.Add(-20*time.Minute))
	hook := func(agentId string, event string, when time.Time) companion.SubagentHookEvent {
		return companion.SubagentHookEvent{AgentSubagentRequest: molten.AgentSubagentRequest{Agent: "claude", AgentId: agentId, Event: event}, At: when.UnixMilli()}
	}
	hooks := []companion.SubagentHookEvent{
		hook("c78f", molten.SubagentEventStart, now.Add(-time.Hour)),
		hook("c78f", molten.SubagentEventStop, now.Add(-30*time.Minute)),
		hook("d90a", molten.SubagentEventStart, now.Add(-time.Hour)),
	}

	adapter := companion.MakeClaudeAdapter([]string{root})
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	places := []AgentPlace{{BlockId: "lead", Agent: "claude", FirstName: "Valentin", Cwd: realPath(dir)}}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return places },
		Subagents: func(places []AgentPlace) []PaneSubagent {
			return PaneSubagentsOf(places, func(blockId string) []companion.SubagentIdentity {
				return companion.ApplyHookSubagents(adapter.ListSubagents(session), hooks, now)
			})
		},
	})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	agents := map[string]BranchAgent{}
	for _, a := range answer.Agents {
		agents[a.Branch] = a
	}
	if a := agents["fix/9201-renamed-branch"]; a.Kind != UpcomingAgentSubagent || a.State != companion.SubagentRunning ||
		a.ParentBlockId != "lead" || a.Description != "#9201 renamed branch" || a.AgentId != "c78f" {
		t.Fatalf("the running sub-agent is on its worktree's live branch: %+v (all %+v)", a, answer.Agents)
	}
	if _, ok := agents["worktree-agent-c78f"]; ok {
		t.Errorf("never on the branch its meta file kept: %+v", answer.Agents)
	}
	if a := agents["fix/9202-finished"]; a.Kind != UpcomingAgentSubagent || a.State != companion.SubagentDone {
		t.Fatalf("the finished sub-agent is not at work: %+v", a)
	}
}
