// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// #1967: a Codex session (Léa) starts three background sub-agents on three tickets, each in its own worktree, the way
// codex-cli 0.166 records a gpt-6 sub-agent: its rollout is a fork of the session's (the session's model, gpt-6-astra,
// in the copied history), its own model and effort are written once when its turn starts, and every command ends as a
// CommandExecution item with a file:// cwd. Their rows must name each sub-agent, with its own model and effort, on
// every refresh: whether one of their commands runs in the worktree at that moment, which the process tree sees, must
// not change the row.

const (
	forkedLeaThread = "01a19b77-e106-7701-9095-d89e1778885a"
	forkedLeaPid    = int32(100)
)

type forkedCardTicket struct {
	number int
	branch string
	task   string
	thread string
	tree   string
}

type forkedCardFixture struct {
	dir     string
	trees   string
	tickets []forkedCardTicket
}

func makeForkedCardRepo(t *testing.T) forkedCardFixture {
	t.Helper()
	f := forkedCardFixture{dir: makeGitFlowRepo(t), trees: realPath(t.TempDir())}
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}","fix":"fix/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(f.dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	for i, c := range []struct {
		number int
		branch string
		task   string
	}{
		{1964, "fix/1964-variable-rpc-boundaries", "fix_1964_vars"},
		{1965, "fix/1965-route-unannounce-ownership", "fix_1965_routes"},
		{1966, "fix/1966-materials-library-performance", "fix_1966_materials"},
	} {
		tree := filepath.Join(f.trees, fmt.Sprintf("mt%d", c.number))
		gitRun(t, f.dir, "worktree", "add", "-q", "-b", c.branch, tree, "develop")
		commit(t, tree, "a.txt", fmt.Sprintf("fix(#%d): a", c.number))
		f.tickets = append(f.tickets, forkedCardTicket{number: c.number, branch: c.branch, task: c.task, thread: fmt.Sprintf("01a1ae11-0000-7000-8000-%012d", i+1), tree: tree})
	}
	if err := os.MkdirAll(filepath.Join(f.dir, "frontend"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func forkedFileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func forkedTurnContext(at time.Time, cwd string, model string, effort string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"turn_context","payload":{"turn_id":"t","cwd":%q,"model":%q,"effort":%q}}`, codexFixtureStamp(at), cwd, model, effort)
}

func forkedCommandExecution(at time.Time, thread string, id string, cwd string, output string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"item_completed","thread_id":%q,"turn_id":"t","item":{"type":"CommandExecution","id":%q,"process_id":"4242","command":["/bin/zsh","-lc","go test ./pkg/..."],"cwd":%q,"parsed_cmd":[],"source":"unified_exec_startup","status":"completed","exit_code":0,"aggregated_output":%q}}}`,
		codexFixtureStamp(at), thread, id, forkedFileURL(cwd), output)
}

// A forkedReader lists a session's sub-agents from its files, as the live layer does; the factory makes a new one, with
// nothing remembered of the files (a window that connects again, an app that restarts).
type forkedReader func(blockId string) []companion.SubagentIdentity

// codexForkedSession writes Léa's rollout and her sub-agents'.
func codexForkedSession(t *testing.T, f forkedCardFixture) func() forkedReader {
	root := t.TempDir()
	now := time.Now().Add(-10 * time.Minute)
	parent := codexFixturePath(root, now, forkedLeaThread)
	header := fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"originator":"codex-tui","cli_version":"0.166.0","source":"cli","thread_source":"user"}}`,
		codexFixtureStamp(now), forkedLeaThread, codexFixtureStamp(now), f.dir)
	writeFixtureLines(t, parent, header, forkedTurnContext(now, f.dir, "gpt-6-astra", "high"), codexFixtureEvent(now, "task_started"))
	for i, c := range f.tickets {
		at := now.Add(time.Duration(i+1) * time.Minute)
		meta := fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"cli_version":"0.166.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":%q,"depth":1,"agent_path":%q,"agent_nickname":"Meitner","agent_role":"sf-fix"}}},"thread_source":"subagent","parent_thread_id":%q}}`,
			codexFixtureStamp(at), c.thread, codexFixtureStamp(at), f.dir, forkedLeaThread, "/root/"+c.task, forkedLeaThread)
		settings := fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":%q,"thread_settings":{"model":"gpt-6.1-sol","reasoning_effort":"medium"}}}`, codexFixtureStamp(at), c.thread)
		lines := []string{
			meta,
			header,
			fmt.Sprintf(`{"timestamp":%q,"type":"compacted","payload":{"message":%q}}`, codexFixtureStamp(at), strings.Repeat("h", 100*1024)),
			forkedTurnContext(at, f.dir, "gpt-6-astra", "high"),
			codexFixtureEvent(at, "turn_aborted"),
			settings,
			codexFixtureEvent(at, "task_started"),
			forkedTurnContext(at, f.dir, "gpt-6.1-sol", "medium"),
		}
		for n := 0; n < 12; n++ {
			lines = append(lines, forkedCommandExecution(at.Add(time.Duration(n)*time.Second), c.thread, fmt.Sprintf("exec-%d", n), c.tree, strings.Repeat("o", 20*1024)))
		}
		writeFixtureLines(t, codexFixturePath(root, at, c.thread), lines...)
	}
	return func() forkedReader {
		adapter := companion.MakeCodexAdapter([]string{root})
		return func(string) []companion.SubagentIdentity {
			return companion.ApplyHookSubagents(adapter.ListSubagents(parent), nil, time.Now())
		}
	}
}

// claudeForkedSession is the same session as Claude Code records it: each sub-agent's meta file names its worktree.
func claudeForkedSession(t *testing.T, f forkedCardFixture) func() forkedReader {
	root := t.TempDir()
	const sessionId = "6a0c3f2e-1b2d-4c5e-8f90-a1b2c3d4e5f6"
	session := filepath.Join(root, companion.ClaudeSlug(f.dir), sessionId+".jsonl")
	subs := filepath.Join(filepath.Dir(session), sessionId, "subagents")
	writeFixtureLines(t, session, `{"type":"user"}`)
	for i, c := range f.tickets {
		id := fmt.Sprintf("a%d4d", i)
		writeFixtureLines(t, filepath.Join(subs, "agent-"+id+".meta.json"), fmt.Sprintf(`{"agentType":"sf-fix","worktreePath":%q,"description":%q}`, c.tree, strings.ReplaceAll(c.task, "_", " ")))
		writeFixtureLines(t, filepath.Join(subs, "agent-"+id+".jsonl"), `{"type":"assistant","message":{"model":"claude-opus-5-5"}}`)
	}
	return func() forkedReader {
		adapter := companion.MakeClaudeAdapter([]string{root})
		return func(string) []companion.SubagentIdentity {
			return companion.ApplyHookSubagents(adapter.ListSubagents(session), nil, time.Now())
		}
	}
}

// forkedProcs: the session's process (pid 100) and a command of one of its sub-agents running in runningIn ("" for
// none: every command is between two others).
func forkedProcs(main string, runningIn string) ProcFacts {
	cwds := map[int32]string{forkedLeaPid: main, 101: main}
	if runningIn != "" {
		cwds[102] = runningIn
	}
	parents := map[int32]int32{101: forkedLeaPid}
	if runningIn != "" {
		parents[102] = 101
	}
	return fakeProcs{parents: parents, cwds: cwds}
}

type forkedSession struct {
	t       *testing.T
	f       forkedCardFixture
	u       *Upcoming
	now     time.Time
	runIn   string
	answers []UpcomingAnswer
}

func startForkedSession(t *testing.T, f forkedCardFixture, agent string, read forkedReader) *forkedSession {
	t.Helper()
	s := &forkedSession{t: t, f: f, now: time.Now()}
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: f.dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	main := realPath(f.dir)
	places := []AgentPlace{{BlockId: "b0", Agent: agent, FirstName: "Léa", Cwd: main, Pid: forkedLeaPid}}
	s.u = MakeUpcoming(UpcomingEnv{
		Run:       run,
		Now:       func() time.Time { return s.now },
		Snapshot:  func(string) (Snapshot, bool) { return snap, true },
		Agents:    func(context.Context) []AgentPlace { return places },
		Subagents: func(places []AgentPlace) []PaneSubagent { return PaneSubagentsOf(places, read) },
		Procs:     func() ProcFacts { return forkedProcs(main, s.runIn) },
	})
	return s
}

// refresh asks again with a command running in runningIn, later than the answer held.
func (s *forkedSession) refresh(runningIn string) UpcomingAnswer {
	s.t.Helper()
	s.runIn = runningIn
	s.now = s.now.Add(time.Minute)
	answer, err := s.u.Get(UpcomingRequest{Dir: s.f.dir, Force: true})
	if err != nil || answer.Error != "" {
		s.t.Fatalf("get: %v %s", err, answer.Error)
	}
	s.answers = append(s.answers, answer)
	return answer
}

func agentsByBranch(answer UpcomingAnswer) map[string][]BranchAgent {
	rtn := map[string][]BranchAgent{}
	for _, a := range answer.Agents {
		rtn[a.Branch] = append(rtn[a.Branch], a)
	}
	return rtn
}

func forkedModel(agent string) (model string, effort string) {
	if agent == "codex" {
		return "gpt-6.1-sol", "medium"
	}
	return "claude-opus-5-5", ""
}

func checkForkedRows(t *testing.T, label string, agent string, f forkedCardFixture, answer UpcomingAnswer) {
	t.Helper()
	model, effort := forkedModel(agent)
	byBranch := agentsByBranch(answer)
	for _, c := range f.tickets {
		got := byBranch[c.branch]
		if len(got) != 1 {
			t.Errorf("%s: one agent on %s, its sub-agent: %+v", label, c.branch, got)
			continue
		}
		a := got[0]
		if a.Kind != UpcomingAgentSubagent || a.Agent != agent || a.ParentBlockId != "b0" || a.ParentFirstName != "Léa" || a.State != companion.SubagentRunning {
			t.Errorf("%s: %s is a sub-agent of Léa's %s session, running (not her panel, not a background guess): %+v", label, c.branch, agent, a)
		}
		if a.Model != model || a.Effort != effort || a.Worktree != c.tree {
			t.Errorf("%s: %s says the sub-agent's own model %q and effort %q, in %s: %+v", label, c.branch, model, effort, c.tree, a)
		}
		if want := strings.ReplaceAll(c.task, "_", " "); a.Description != want {
			t.Errorf("%s: %s says its task %q: %+v", label, c.branch, want, a)
		}
	}
	if lead := byBranch["develop"]; len(lead) != 1 || lead[0].Kind != UpcomingAgentPanel || lead[0].BlockId != "b0" {
		t.Errorf("%s: Léa's own terminal is on develop, where it started: %+v", label, lead)
	}
	rows := map[int]bool{}
	for _, b := range answer.Branches {
		rows[b.Ticket] = true
	}
	for _, c := range f.tickets {
		if !rows[c.number] {
			t.Errorf("%s: a row for #%d: %+v", label, c.number, answer.Branches)
		}
	}
	if len(answer.Agents) != len(f.tickets)+1 {
		t.Errorf("%s: three sub-agents and Léa's terminal, nobody else: %+v", label, answer.Agents)
	}
}

func TestUpcomingKeepsSubagentsOnTheirTicketsWhateverTheProcessTreeSays(t *testing.T) {
	f := makeForkedCardRepo(t)
	for _, c := range []struct {
		agent   string
		session func() forkedReader
	}{
		{"codex", codexForkedSession(t, f)},
		{"claude", claudeForkedSession(t, f)},
	} {
		s := startForkedSession(t, f, c.agent, c.session())
		// A command of a sub-agent runs in the worktree of #1964, then in another, then none runs, then one again.
		for i, running := range []string{f.tickets[0].tree, f.tickets[1].tree, "", f.tickets[2].tree, ""} {
			checkForkedRows(t, fmt.Sprintf("%s, refresh %d", c.agent, i+1), c.agent, f, s.refresh(running))
		}
		// A window that connects again, an app that restarted: nothing remembered, the files read again.
		checkForkedRows(t, c.agent+", a new Upcoming", c.agent, f, startForkedSession(t, f, c.agent, c.session()).refresh(""))
		checkForkedGolden(t, c.agent, f, s.answers[0])
	}
	if !t.Failed() {
		writeForkedGolden(t)
	}
}

// The answers both sessions give, shared with the view's test (reviews-upcoming-forked.test.ts), which builds the
// card from them: MOLTEN_UPDATE_GOLDEN=1 rewrites it.
const forkedCardGolden = "../../../frontend/moltenterm-shell/reviews/testdata/upcoming-forked-card.json"

var forkedGoldenAnswers = map[string]subagentCardAnswer{}

func checkForkedGolden(t *testing.T, agent string, f forkedCardFixture, answer UpcomingAnswer) {
	t.Helper()
	main := realPath(f.dir)
	clean := func(p string) string {
		if rest, ok := strings.CutPrefix(p, f.trees); ok {
			return "/trees" + rest
		}
		if rest, ok := strings.CutPrefix(p, main); ok {
			return "/p" + rest
		}
		return p
	}
	rtn := subagentCardAnswer{Dir: "/p", Branches: []UpcomingBranch{}, Agents: []BranchAgent{}, At: subagentCardGoldenAt}
	for _, b := range answer.Branches {
		b.Worktree = clean(b.Worktree)
		if b.CommitAt > 0 {
			b.CommitAt = subagentCardGoldenAt - 10*60_000
		}
		rtn.Branches = append(rtn.Branches, b)
	}
	for _, ag := range answer.Agents {
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
	forkedGoldenAnswers[agent] = rtn
}

func writeForkedGolden(t *testing.T) {
	t.Helper()
	data, err := json.MarshalIndent(forkedGoldenAnswers, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if os.Getenv("MOLTEN_UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(forkedCardGolden, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(forkedCardGolden)
	if err != nil {
		t.Fatal(err)
	}
	if string(have) != string(data) {
		t.Errorf("the answers the view's test reads changed (MOLTEN_UPDATE_GOLDEN=1 rewrites them):\n%s", data)
	}
}
