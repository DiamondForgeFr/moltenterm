// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// #1476: a main agent session whose terminal stays in the main checkout while it works in a ticket's worktree. Codex
// keeps the main checkout as its turns' cwd and runs each command in the worktree (a shell call's workdir); Claude Code
// moves its records' cwd there. Both fixtures are read by the agent's own adapter (WorkFolderReader), as the live
// layer does.

const codexFixtureMain = "01a1a476-0000-7000-8000-000000000001"

// codexMainSession writes a Codex session's rollout started in the main checkout whose commands then run in the given
// folders, the newest last; it returns the folder its adapter reads it works in.
func codexMainSession(t *testing.T, f subagentCardFixture, workdirs ...string) string {
	t.Helper()
	root := t.TempDir()
	now := time.Now().Add(-5 * time.Minute)
	rollout := codexFixturePath(root, now, codexFixtureMain)
	lines := []string{
		fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"originator":"codex-tui","cli_version":"0.170.0","source":"cli","thread_source":"user"}}`,
			codexFixtureStamp(now), codexFixtureMain, codexFixtureStamp(now), f.dir),
		codexFixtureTurnContext(now, f.dir),
		codexFixtureEvent(now, "task_started"),
	}
	for i, dir := range workdirs {
		lines = append(lines, codexFixtureExec(now.Add(time.Duration(i+1)*time.Second), fmt.Sprintf("c%d", i), "git status", dir))
	}
	writeFixtureLines(t, rollout, lines...)
	work, _ := companion.MakeCodexAdapter([]string{root}).WorkFolder(rollout)
	return work
}

// claudeMainSession writes a Claude Code session started in the main checkout whose latest record's cwd is cwd.
func claudeMainSession(t *testing.T, f subagentCardFixture, cwd string) string {
	t.Helper()
	root := t.TempDir()
	session := companion.ClaudeSlug(f.dir) + "/7b1d4f3e-2c3e-4d6f-9a01-b2c3d4e5f607.jsonl"
	rec := func(kind string, dir string) string {
		data, _ := json.Marshal(map[string]any{"type": kind, "cwd": dir, "sessionId": "7b1d4f3e-2c3e-4d6f-9a01-b2c3d4e5f607"})
		return string(data)
	}
	path := root + "/" + session
	writeFixtureLines(t, path, rec("user", f.dir), rec("assistant", f.dir), rec("user", cwd))
	work, _ := companion.MakeClaudeAdapter([]string{root}).WorkFolder(path)
	return work
}

func sessionPlaceAnswer(t *testing.T, f subagentCardFixture, place AgentPlace) map[string]BranchAgent {
	t.Helper()
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: f.dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return []AgentPlace{place} },
	})
	answer, err := u.Get(UpcomingRequest{Dir: f.dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	agents := map[string]BranchAgent{}
	for _, a := range answer.Agents {
		agents[a.Branch] = a
	}
	return agents
}

func TestUpcomingPlacesSessionInTheWorktreeItWorksIn(t *testing.T) {
	f := makeSubagentCardRepo(t)
	main := realPath(f.dir)
	for _, c := range []struct {
		name   string
		agent  string
		work   string
		branch string
	}{
		// Its commands moved to the ticket's worktree.
		{"codex in a worktree", "codex", codexMainSession(t, f, f.dir, f.running), "fix/1462-codex-sessions"},
		// A worktree checked once, then back in the main checkout: the newest command decides.
		{"codex back home", "codex", codexMainSession(t, f, f.running, f.dir), "develop"},
		// A command in a subfolder of the main checkout names no worktree.
		{"codex in a subfolder", "codex", codexMainSession(t, f, "frontend"), "develop"},
		{"claude in a worktree", "claude", claudeMainSession(t, f, f.running), "fix/1462-codex-sessions"},
		{"claude at home", "claude", claudeMainSession(t, f, f.dir), "develop"},
	} {
		place := AgentPlace{BlockId: "b0", Agent: c.agent, FirstName: "Lucie", Cwd: main, Work: realPath(c.work)}
		agents := sessionPlaceAnswer(t, f, place)
		a, ok := agents[c.branch]
		if !ok || a.Kind != UpcomingAgentPanel || a.BlockId != "b0" || a.FirstName != "Lucie" || a.Agent != c.agent {
			t.Errorf("%s (work %q): the session's panel is on %s: %+v (all %+v)", c.name, c.work, c.branch, a, agents)
		}
		if c.branch == "develop" {
			if a := agents["fix/1462-codex-sessions"]; a.Kind == UpcomingAgentPanel {
				t.Errorf("%s: the session is not on the worktree it left: %+v", c.name, a)
			}
			continue
		}
		if a := agents["develop"]; a.BlockId == "b0" {
			t.Errorf("%s: the session is no longer in the main checkout: %+v", c.name, a)
		}
	}
}

// Work only moves a terminal to another worktree of the project: a folder outside them keeps its terminal's place, and
// a terminal linked to a worktree whose session works there stays.
func TestPlaceTreeKeepsTheTerminalsPlaceOutsideTheProject(t *testing.T) {
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/p/.claude/worktrees/a", branch: "feature/7-a"},
		{path: "/x/b", branch: "fix/8-b"},
	}
	for _, c := range []struct {
		place AgentPlace
		want  string
	}{
		{AgentPlace{Cwd: "/p", Work: "/tmp/elsewhere"}, "/p"},
		{AgentPlace{Cwd: "/p", Work: "/x/b/src"}, "/x/b"},
		{AgentPlace{Link: "/p/.claude/worktrees/a", Cwd: "/p", Work: "/p/.claude/worktrees/a"}, "/p/.claude/worktrees/a"},
		{AgentPlace{Cwd: "/p/sub", Work: "/p"}, "/p"},
		{AgentPlace{Work: "/x/b"}, "/x/b"},
		{AgentPlace{Cwd: "/p", Work: "relative"}, "/p"},
	} {
		tree, ok := placeTree(trees, c.place)
		if !ok || tree.path != c.want {
			t.Errorf("%+v: placed in %q %v, want %q", c.place, tree.path, ok, c.want)
		}
	}
}
