// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// #1463: a Codex session and its sub-agents get the same Integration card as a Claude Code session's. Both fixtures
// describe one session in the main checkout (on develop) with two sub-agents, one at work on fix/1462-… and one
// finished on feature/1029-…, each in its own linked worktree. Claude Code names the worktree in the sub-agent's meta
// file; Codex starts its sub-agents in the parent's folder (their turns' cwd is the main checkout) and they run each
// command in their worktree (a shell call's workdir), the way codex-cli writes it.

const (
	codexFixtureParent  = "01a1a463-0000-7000-8000-000000000001"
	codexFixtureRunning = "01a1a463-0000-7000-8000-000000000002"
	codexFixtureDone    = "01a1a463-0000-7000-8000-000000000003"
)

type subagentCardFixture struct {
	dir     string
	running string
	done    string
}

func makeSubagentCardRepo(t *testing.T) subagentCardFixture {
	t.Helper()
	f := subagentCardFixture{dir: makeGitFlowRepo(t)}
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}","fix":"fix/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(f.dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	trees := realPath(t.TempDir())
	f.running = filepath.Join(trees, "mt-1462")
	f.done = filepath.Join(trees, "mt-1029")
	gitRun(t, f.dir, "worktree", "add", "-q", "-b", "fix/1462-codex-sessions", f.running, "develop")
	gitRun(t, f.dir, "worktree", "add", "-q", "-b", "feature/1029-notes", f.done, "develop")
	commit(t, f.running, "a.txt", "fix: a")
	commit(t, f.done, "b.txt", "feat: b")
	if err := os.MkdirAll(filepath.Join(f.dir, "frontend"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func writeFixtureLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The Claude Code fixture: the session's two sub-agent meta files name their worktrees.
func claudeSubagentSession(t *testing.T, f subagentCardFixture) func(blockId string) []companion.SubagentIdentity {
	root := t.TempDir()
	session := filepath.Join(root, companion.ClaudeSlug(f.dir), "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6.jsonl")
	subs := filepath.Join(filepath.Dir(session), "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6", "subagents")
	writeFixtureLines(t, session, `{"type":"user"}`)
	writeFixtureLines(t, filepath.Join(subs, "agent-a34d.meta.json"), fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"#1462 codex sessions"}`, f.running))
	writeFixtureLines(t, filepath.Join(subs, "agent-a34d.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`)
	writeFixtureLines(t, filepath.Join(subs, "agent-b56e.meta.json"), fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"#1029 release notes","finished":true}`, f.done))
	writeFixtureLines(t, filepath.Join(subs, "agent-b56e.jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`)
	adapter := companion.MakeClaudeAdapter([]string{root})
	return func(string) []companion.SubagentIdentity {
		return companion.ApplyHookSubagents(adapter.ListSubagents(session), nil, time.Now())
	}
}

func codexFixtureStamp(at time.Time) string {
	return at.UTC().Format(time.RFC3339Nano)
}

func codexFixturePath(root string, at time.Time, id string) string {
	dir := filepath.Join(root, at.Format("2006"), at.Format("01"), at.Format("02"))
	return filepath.Join(dir, "rollout-"+at.Format("2006-01-02T15-04-05")+"-"+id+".jsonl")
}

func codexFixtureSubMeta(id string, path string, nickname string, cwd string, at time.Time) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"cli_version":"0.170.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":%q,"depth":1,"agent_path":%q,"agent_nickname":%q,"agent_role":"worker"}}},"thread_source":"subagent","parent_thread_id":%q}}`,
		codexFixtureStamp(at), id, codexFixtureStamp(at), cwd, codexFixtureParent, path, nickname, codexFixtureParent)
}

func codexFixtureTurnContext(at time.Time, cwd string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"turn_context","payload":{"turn_id":"t","cwd":%q,"model":"gpt-5.5","effort":"high"}}`, codexFixtureStamp(at), cwd)
}

func codexFixtureEvent(at time.Time, kind string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":%q,"turn_id":"t"}}`, codexFixtureStamp(at), kind)
}

// A shell call as codex-cli records it: the command's arguments are a JSON string holding its workdir.
func codexFixtureExec(at time.Time, callId string, cmd string, workdir string) string {
	args, _ := json.Marshal(map[string]any{"cmd": cmd, "workdir": workdir, "yield_time_ms": 10000})
	return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":%q,"call_id":%q}}`,
		codexFixtureStamp(at), string(args), callId)
}

// The Codex fixture: the parent's rollout spawns two agents; each sub-agent's rollout keeps the main checkout as its
// turns' cwd and runs its commands in its worktree, then once in a subfolder of the main checkout and once outside
// any repository (neither names another worktree).
func codexSubagentSession(t *testing.T, f subagentCardFixture) func(blockId string) []companion.SubagentIdentity {
	root := t.TempDir()
	outside := t.TempDir()
	now := time.Now().Add(-5 * time.Minute)
	parent := codexFixturePath(root, now, codexFixtureParent)
	spawn := func(at time.Time, callId string, task string) string {
		args, _ := json.Marshal(map[string]any{"task_name": task, "agent_type": "worker", "message": "gAAAAABencrypted=="})
		return fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","namespace":"collaboration","arguments":%q,"call_id":%q}}`,
			codexFixtureStamp(at), string(args), callId)
	}
	writeFixtureLines(t, parent,
		fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"originator":"codex-tui","cli_version":"0.170.0","source":"cli","thread_source":"user"}}`,
			codexFixtureStamp(now), codexFixtureParent, codexFixtureStamp(now), f.dir),
		codexFixtureTurnContext(now, f.dir),
		codexFixtureEvent(now, "task_started"),
		spawn(now.Add(time.Second), "call_1462", "ticket_1462_codex_sessions"),
		spawn(now.Add(2*time.Second), "call_1029", "ticket_1029_release_notes"),
	)
	writeFixtureLines(t, codexFixturePath(root, now.Add(time.Second), codexFixtureRunning),
		codexFixtureSubMeta(codexFixtureRunning, "/root/ticket_1462_codex_sessions", "Nash", f.dir, now.Add(time.Second)),
		codexFixtureTurnContext(now.Add(time.Second), f.dir),
		codexFixtureEvent(now.Add(time.Second), "task_started"),
		codexFixtureExec(now.Add(2*time.Second), "c1", "git status", f.running),
		codexFixtureExec(now.Add(3*time.Second), "c2", "ls", "frontend"),
		codexFixtureExec(now.Add(4*time.Second), "c3", "ls", outside),
	)
	writeFixtureLines(t, codexFixturePath(root, now.Add(2*time.Second), codexFixtureDone),
		codexFixtureSubMeta(codexFixtureDone, "/root/ticket_1029_release_notes", "Bohr", f.dir, now.Add(2*time.Second)),
		codexFixtureTurnContext(now.Add(2*time.Second), f.dir),
		codexFixtureEvent(now.Add(2*time.Second), "task_started"),
		codexFixtureExec(now.Add(3*time.Second), "d1", "git log -1", f.done),
		codexFixtureEvent(now.Add(time.Minute), "task_complete"),
	)
	adapter := companion.MakeCodexAdapter([]string{root})
	return func(string) []companion.SubagentIdentity {
		return companion.ApplyHookSubagents(adapter.ListSubagents(parent), nil, time.Now())
	}
}

func subagentCardAgents(t *testing.T, f subagentCardFixture, agent string, read func(blockId string) []companion.SubagentIdentity) (UpcomingAnswer, map[string]BranchAgent) {
	t.Helper()
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: f.dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	places := []AgentPlace{{BlockId: "b0", Agent: agent, FirstName: "Adrien", Cwd: realPath(f.dir)}}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return places },
		Subagents: func(places []AgentPlace) []PaneSubagent {
			return PaneSubagentsOf(places, read)
		},
	})
	answer, err := u.Get(UpcomingRequest{Dir: f.dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	rows := map[string]bool{}
	for _, b := range answer.Branches {
		rows[b.Branch] = true
	}
	if !rows["fix/1462-codex-sessions"] || !rows["feature/1029-notes"] {
		t.Fatalf("%s: both branches are upcoming: %+v", agent, answer.Branches)
	}
	agents := map[string]BranchAgent{}
	for _, a := range answer.Agents {
		agents[a.Branch] = a
	}
	return answer, agents
}

// The answers both fixtures give, shared with the view's test (reviews-upcoming-model.test.ts), which builds the
// session card from them: MOLTEN_UPDATE_GOLDEN=1 rewrites it.
const subagentCardGolden = "../../../frontend/moltenterm-shell/reviews/testdata/upcoming-subagent-card.json"

const subagentCardGoldenAt = int64(1_793_000_000_000)

type subagentCardAnswer struct {
	Dir      string           `json:"dir"`
	Branches []UpcomingBranch `json:"branches"`
	Agents   []BranchAgent    `json:"agents"`
	At       int64            `json:"at"`
}

// goldenCardAnswer keeps an answer's rows and agents, its folders and times made the same on every run.
func goldenCardAnswer(f subagentCardFixture, a UpcomingAnswer) subagentCardAnswer {
	trees := filepath.Dir(f.running)
	main := realPath(f.dir)
	clean := func(p string) string {
		if rest, ok := strings.CutPrefix(p, trees); ok {
			return "/trees" + rest
		}
		if rest, ok := strings.CutPrefix(p, main); ok {
			return "/p" + rest
		}
		return p
	}
	rtn := subagentCardAnswer{Dir: "/p", Branches: []UpcomingBranch{}, Agents: []BranchAgent{}, At: subagentCardGoldenAt}
	for _, b := range a.Branches {
		b.Worktree = clean(b.Worktree)
		if b.CommitAt > 0 {
			b.CommitAt = subagentCardGoldenAt - 10*60_000
		}
		rtn.Branches = append(rtn.Branches, b)
	}
	for _, ag := range a.Agents {
		ag.Worktree = clean(ag.Worktree)
		if ag.ActiveAt > 0 {
			ag.ActiveAt = subagentCardGoldenAt - 60_000
		}
		if ag.Started > 0 {
			ag.Started = subagentCardGoldenAt - 5*60_000
		}
		rtn.Agents = append(rtn.Agents, ag)
	}
	sort.Slice(rtn.Branches, func(i, j int) bool { return rtn.Branches[i].Branch < rtn.Branches[j].Branch })
	sort.Slice(rtn.Agents, func(i, j int) bool { return rtn.Agents[i].Branch < rtn.Agents[j].Branch })
	return rtn
}

func checkSubagentCardGolden(t *testing.T, answers map[string]subagentCardAnswer) {
	t.Helper()
	data, err := json.MarshalIndent(answers, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if os.Getenv("MOLTEN_UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(subagentCardGolden, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(subagentCardGolden)
	if err != nil {
		t.Fatal(err)
	}
	if string(have) != string(data) {
		t.Errorf("the answers the view's test reads changed (MOLTEN_UPDATE_GOLDEN=1 rewrites them):\n%s", data)
	}
}

// cardFacts is what the session card shows of a sub-agent, its tool's own words (model, task) left out.
func cardFacts(a BranchAgent) string {
	return fmt.Sprintf("kind=%s parent=%s/%s state=%s worktree=%s model?%v task?%v active?%v",
		a.Kind, a.ParentBlockId, a.ParentFirstName, a.State, a.Worktree, a.Model != "", a.Description != "", a.ActiveAt > 0)
}

func TestUpcomingNamesCodexSubagentsLikeClaude(t *testing.T) {
	f := makeSubagentCardRepo(t)
	claudeAnswer, claude := subagentCardAgents(t, f, "claude", claudeSubagentSession(t, f))
	codexAnswer, codex := subagentCardAgents(t, f, "codex", codexSubagentSession(t, f))
	want := map[string]string{
		"fix/1462-codex-sessions": fmt.Sprintf("kind=subagent parent=b0/Adrien state=running worktree=%s model?true task?true active?true", f.running),
		"feature/1029-notes":      fmt.Sprintf("kind=subagent parent=b0/Adrien state=done worktree=%s model?true task?true active?true", f.done),
	}
	for branch, facts := range want {
		if got := cardFacts(claude[branch]); got != facts {
			t.Errorf("Claude Code fixture, %s:\n got %s\nwant %s", branch, got, facts)
		}
		if got := cardFacts(codex[branch]); got != facts {
			t.Errorf("Codex fixture, %s (a background guess instead of its sub-agent?):\n got %s (%+v)\nwant %s", branch, got, codex[branch], facts)
		}
	}
	if a := codex["fix/1462-codex-sessions"]; a.Agent != "codex" || a.Model != "gpt-5.5" || a.Description != "ticket 1462 codex sessions" {
		t.Errorf("the Codex sub-agent's tool, model and task: %+v", a)
	}
	if a := claude["fix/1462-codex-sessions"]; a.Agent != "claude" || a.Model != "claude-opus-5-5" || a.Description != "#1462 codex sessions" {
		t.Errorf("the Claude Code sub-agent's tool, model and task: %+v", a)
	}
	checkSubagentCardGolden(t, map[string]subagentCardAnswer{
		"claude": goldenCardAnswer(f, claudeAnswer),
		"codex":  goldenCardAnswer(f, codexAnswer),
	})
}

// A background worktree is attributed to a parent through its agent's own worktrees folder, whatever the agent: Claude
// Code's .claude/worktrees names a Claude Code session; a folder no agent declares names nobody.
func TestBackgroundAgentsParentByAgentWorktreesDir(t *testing.T) {
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/p/.claude/worktrees/a", branch: "feature/7-a"},
		{path: "/x/b", branch: "feature/8-b"},
	}
	places := []AgentPlace{
		{BlockId: "claude1", Agent: "claude", FirstName: "Valentin", Cwd: "/p"},
		{BlockId: "codex1", Agent: "codex", FirstName: "Adrien", Cwd: "/p"},
	}
	activity := map[string]int64{"/p/.claude/worktrees/a": 100, "/x/b": 100}
	got := BackgroundAgents(trees, nil, places, activity, time.UnixMilli(200))
	if len(got) != 2 {
		t.Fatalf("two background agents: %+v", got)
	}
	if a := got[0]; a.Agent != "claude" || a.ParentBlockId != "claude1" || a.ParentFirstName != "Valentin" {
		t.Errorf("a Claude Code worktree agent's parent is the one Claude Code session, not the Codex one: %+v", a)
	}
	if a := got[1]; a.Agent != "" || a.ParentBlockId != "" {
		t.Errorf("a worktree outside any agent's folder has no known parent: %+v", a)
	}
}
