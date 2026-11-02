// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

func TestSubagentBranchAgents(t *testing.T) {
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/p/.claude/worktrees/a", branch: "feature/7-a"},
		{path: "/p/.claude/worktrees/b", branch: "feature/8-b"},
		{path: "/x/d", branch: "feature/10-d"},
	}
	panels := []BranchAgent{{Branch: "feature/10-d", Worktree: "/x/d", Kind: UpcomingAgentPanel}}
	sub := func(worktree string, state string, at int64, desc string) PaneSubagent {
		return PaneSubagent{ParentBlockId: "parent", ParentFirstName: "Valentin", Agent: "claude", SubagentIdentity: companion.SubagentIdentity{
			Worktree: worktree, State: state, LastWrite: at, Description: desc, Model: "claude-opus-5-5",
		}}
	}
	subs := []PaneSubagent{
		sub("/p/.claude/worktrees/a", companion.SubagentDone, 50, "older, finished"),
		sub("/p/.claude/worktrees/a/src", companion.SubagentRunning, 10, "#7 working"),
		sub("/p/.claude/worktrees/b", companion.SubagentDone, 20, "#8 finished"),
		sub("/x/d", companion.SubagentRunning, 99, "a panel works there"),
		sub("/p", companion.SubagentRunning, 99, "the main checkout"),
		sub("relative", companion.SubagentRunning, 99, "no absolute folder"),
	}
	got := SubagentBranchAgents(trees, panels, subs)
	if len(got) != 2 {
		t.Fatalf("one sub-agent per linked worktree without a panel: %+v", got)
	}
	if a := got[0]; a.Branch != "feature/7-a" || a.Kind != UpcomingAgentSubagent || a.Description != "#7 working" || a.State != companion.SubagentRunning ||
		a.ParentBlockId != "parent" || a.ParentFirstName != "Valentin" || a.Agent != "claude" || a.Model != "claude-opus-5-5" {
		t.Fatalf("the running sub-agent wins: %+v", a)
	}
	if a := got[1]; a.Branch != "feature/8-b" || a.State != companion.SubagentDone || a.ActiveAt != 20 {
		t.Fatalf("finished sub-agent: %+v", a)
	}
	// A finished sub-agent's branch is no longer one an agent works on.
	if br := agentBranches(got); !br["feature/7-a"] || br["feature/8-b"] {
		t.Fatalf("agent branches: %+v", br)
	}
	// Its worktree is no background guess.
	activity := map[string]int64{"/p/.claude/worktrees/a": 1, "/p/.claude/worktrees/b": 1}
	if bg := BackgroundAgents(trees, append(panels, got...), nil, activity, time.UnixMilli(2)); len(bg) != 0 {
		t.Fatalf("background guesses: %+v", bg)
	}
}

// The ticket's fixture (#1035): a parent session with two sub-agent meta files, one running and one finished, whose
// worktrees hold two ticket branches; the two Upcoming rows carry the parent, tool, model, task and state.
func TestUpcomingNamesSubagents(t *testing.T) {
	dir := makeGitFlowRepo(t)
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	running := filepath.Join(dir, ".claude", "worktrees", "agent-a34d")
	done := filepath.Join(dir, ".claude", "worktrees", "agent-b56e")
	gitRun(t, dir, "worktree", "add", "-q", "-b", "feature/1033-agent-name", running, "develop")
	gitRun(t, dir, "worktree", "add", "-q", "-b", "feature/1029-notes", done, "develop")
	commit(t, running, "a.txt", "feat: a")
	commit(t, done, "b.txt", "feat: b")

	root := t.TempDir()
	session := filepath.Join(root, companion.ClaudeSlug(dir), "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6.jsonl")
	subs := filepath.Join(filepath.Dir(session), "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6", "subagents")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(path string, text string) {
		if err := os.WriteFile(path, []byte(text+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(session, `{"type":"user"}`)
	write(filepath.Join(subs, "agent-a34d.meta.json"), fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"#1033 agent name in tabs","requestShape":"background"}`, running))
	write(filepath.Join(subs, "agent-a34d.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`)
	write(filepath.Join(subs, "agent-b56e.meta.json"), fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"#1029 release notes","finished":true}`, done))
	write(filepath.Join(subs, "agent-b56e.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`)

	adapter := companion.MakeClaudeAdapter([]string{root})
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	places := []AgentPlace{{BlockId: "b0", Agent: "claude", FirstName: "Valentin", Cwd: realPath(dir)}}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return places },
		Subagents: func(places []AgentPlace) []PaneSubagent {
			return PaneSubagentsOf(places, func(blockId string) []companion.SubagentIdentity {
				return companion.ApplyHookSubagents(adapter.ListSubagents(session), nil, time.Now())
			})
		},
	})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	rows := map[string]bool{}
	for _, b := range answer.Branches {
		rows[b.Branch] = true
	}
	if !rows["feature/1033-agent-name"] || !rows["feature/1029-notes"] {
		t.Fatalf("both branches are upcoming: %+v", answer.Branches)
	}
	agents := map[string]BranchAgent{}
	for _, a := range answer.Agents {
		agents[a.Branch] = a
	}
	if a := agents["feature/1033-agent-name"]; a.Kind != UpcomingAgentSubagent || a.ParentBlockId != "b0" || a.ParentFirstName != "Valentin" ||
		a.Agent != "claude" || a.Model != "claude-opus-5-5" || a.Description != "#1033 agent name in tabs" || a.State != companion.SubagentRunning {
		t.Fatalf("running sub-agent: %+v", a)
	}
	if a := agents["feature/1029-notes"]; a.Kind != UpcomingAgentSubagent || a.Description != "#1029 release notes" || a.State != companion.SubagentDone || a.ActiveAt == 0 {
		t.Fatalf("finished sub-agent: %+v", a)
	}
}
