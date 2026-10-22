// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestResolveTicket(t *testing.T) {
	cases := []struct {
		own, text string
		want      int
	}{
		{"feature/601-agents", "#5", 601},
		{"worktree-agent-abc", "#5 Reviews", 5},
		{"develop", "Fix #77 now", 77},
		{"feature/601", "", 601},
		{"feature/abc-601", "", 0},
		{"develop", "a#12 or &#39; or x/#4", 0},
		{"", "#12345678901", 0},
		{"worktree-agent-abc", "no ticket", 0},
	}
	for _, c := range cases {
		if got := resolveTicket(c.own, c.text); got != c.want {
			t.Errorf("resolveTicket(%q, %q) = %d, want %d", c.own, c.text, got, c.want)
		}
	}
}

func TestComplexityOfLabels(t *testing.T) {
	if got := ComplexityOfLabels([]string{"nature:user-facing", "complexity: medium"}); got != ComplexityMedium {
		t.Errorf("medium: %q", got)
	}
	if got := ComplexityOfLabels([]string{"Complexity:Complex"}); got != ComplexityComplex {
		t.Errorf("case and spaces: %q", got)
	}
	if got := ComplexityOfLabels([]string{"bug", "complexity: huge", "low"}); got != "" {
		t.Errorf("no workflow label: %q", got)
	}
}

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	text := ""
	for _, l := range lines {
		text += l + "\n"
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// makeRepo makes dir a repository checked out on branch: only the files FolderBranch reads.
func makeRepo(t *testing.T, dir string, branch string) {
	t.Helper()
	os.MkdirAll(filepath.Join(dir, ".git"), 0o700)
	writeLines(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/"+branch)
}

// makeWorktree makes dir a worktree of the repository at repo, checked out on branch ("" for a detached HEAD).
func makeWorktree(t *testing.T, repo string, dir string, branch string) {
	t.Helper()
	gitDir := filepath.Join(repo, ".git", "worktrees", filepath.Base(dir))
	os.MkdirAll(gitDir, 0o700)
	os.MkdirAll(dir, 0o700)
	writeLines(t, filepath.Join(dir, ".git"), "gitdir: "+gitDir)
	head := "ref: refs/heads/" + branch
	if branch == "" {
		head = "3f0a31bb4f3f81328496e2b39cdcbef1aaaaaaaa"
	}
	writeLines(t, filepath.Join(gitDir, "HEAD"), head)
}

func TestFolderBranch(t *testing.T) {
	repo := t.TempDir()
	makeRepo(t, repo, "develop")
	os.MkdirAll(filepath.Join(repo, "pkg", "deep"), 0o700)
	wt := filepath.Join(repo, ".claude", "worktrees", "agent-a1")
	makeWorktree(t, repo, wt, "fix/961-status-bar")
	detached := filepath.Join(repo, ".claude", "worktrees", "agent-a2")
	makeWorktree(t, repo, detached, "")
	cases := map[string]string{
		repo:                               "develop",
		filepath.Join(repo, "pkg", "deep"): "develop",
		wt:                                 "fix/961-status-bar",
		detached:                           "",
		"relative/path":                    "",
		"":                                 "",
	}
	for dir, want := range cases {
		if got := FolderBranch(dir); got != want {
			t.Errorf("FolderBranch(%q) = %q, want %q", dir, got, want)
		}
	}
}

func TestReadSubagentFacts(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	makeRepo(t, repo, "develop")
	wt := filepath.Join(repo, ".claude", "worktrees", "agent-aa1")
	makeWorktree(t, repo, wt, "feature/601-agents")
	dir := filepath.Join(root, "-work-demo")
	subs := filepath.Join(dir, "sess", "subagents")
	os.MkdirAll(subs, 0o700)
	session := filepath.Join(dir, "sess.jsonl")
	writeLines(t, session, `{}`)
	writeLines(t, filepath.Join(subs, "agent-aa1.meta.json"), fmt.Sprintf(`{"agentType":"general-purpose","toolUseId":"call-1","worktreePath":%q}`, wt))
	writeLines(t, filepath.Join(subs, "agent-bad id.meta.json"), `{"toolUseId":"call-x"}`)
	writeLines(t, filepath.Join(subs, "agent-aa1.jsonl"),
		`{"type":"user","gitBranch":"develop","message":{"role":"user","content":"go"}}`,
		`{"type":"assistant","gitBranch":"fix/954-other-worktree","effort":"high","message":{"model":"claude-sonnet-4-5","content":[]}}`,
		`{"type":"assistant","gitBranch":"fix/954-other-worktree","message":{"model":"<synthetic>","content":[]}}`,
		`not json`,
	)
	// A sub-agent without a worktree works in its records' cwd.
	writeLines(t, filepath.Join(subs, "agent-aa2.jsonl"),
		fmt.Sprintf(`{"type":"assistant","cwd":%q,"gitBranch":"fix/954-other-worktree","message":{"model":"claude-sonnet-4-5","content":[]}}`, repo),
	)
	if facts, ok := MakeClaudeAdapter([]string{root}).ReadSubagent(session, "aa2"); !ok || facts.Branch != "develop" {
		t.Errorf("the branch of the records' cwd: %+v %v", facts, ok)
	}
	a := MakeClaudeAdapter([]string{root})
	ids := a.SubagentIds(session)
	if len(ids) != 1 || ids["call-1"] != "aa1" {
		t.Fatalf("meta files map calls to agents: %v", ids)
	}
	facts, ok := a.ReadSubagent(session, "aa1")
	if !ok || facts.Branch != "feature/601-agents" || facts.Effort != "high" || facts.Model != "claude-sonnet-4-5" {
		t.Fatalf("latest facts of the transcript: %+v %v", facts, ok)
	}
	if _, ok := a.ReadSubagent(session, "../aa1"); ok {
		t.Error("an agent id names a file of the folder only")
	}
}

func TestSubagentEffortFromCall(t *testing.T) {
	a := MakeClaudeAdapter([]string{"/nowhere"})
	s := MakeSession()
	parseRecordLine(a, s, []byte(`{"type":"assistant","sessionId":"s","gitBranch":"fix/9-x","effort":"medium","timestamp":"2026-10-14T08:00:00.000Z","message":{"model":"claude-opus-5-5","content":[{"type":"tool_use","id":"call-1","name":"Agent","input":{"description":"Review #12","subagent_type":"general-purpose","effort":"low","model":"haiku"}}]}}`))
	subs := s.Subagents()
	if len(subs) != 1 || subs[0].Effort != "low" || subs[0].Model != "haiku" {
		t.Fatalf("the call's effort and model: %+v", subs)
	}
	if s.Model() != "claude-opus-5-5" || s.Effort() != "medium" {
		t.Errorf("the main agent's model and effort: %q %q", s.Model(), s.Effort())
	}
	s.ResolveTickets(nil)
	if n, _ := s.Ticket(); n != 9 || s.Subagents()[0].Ticket != 12 {
		t.Errorf("the main agent's branch, the sub-agent's own description: main %d, sub %+v", n, s.Subagents()[0])
	}
	s.SetFolderBranch("")
	s.ResolveTickets(nil)
	if n, _ := s.Ticket(); n != 0 || s.Branch() != "" {
		t.Errorf("a folder read on no branch wins over the records': no stale ticket, got %d on %q", n, s.Branch())
	}
}

type fakeLabels struct {
	lock   sync.Mutex
	calls  map[int]int
	labels map[int][]string
}

func (f *fakeLabels) lookup(ctx context.Context, dir string, number int) ([]string, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls[number]++
	labels, ok := f.labels[number]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return labels, nil
}

func (f *fakeLabels) count() map[int]int {
	f.lock.Lock()
	defer f.lock.Unlock()
	rtn := map[int]int{}
	for k, v := range f.calls {
		rtn[k] = v
	}
	return rtn
}

// AC2 and AC4: a sub-agent in a feature/N-… worktree gets ticket N and its complexity; gh is asked only after a
// refresh (a companion that shows), once per ticket however often it refreshes.
func TestTicketComplexityOnRefreshOnly(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	makeRepo(t, cwd, "feature/601-x")
	wt := filepath.Join(cwd, ".claude", "worktrees", "agent-aa1")
	makeWorktree(t, cwd, wt, "feature/700-y")
	dir := filepath.Join(root, ClaudeSlug(cwd))
	subs := filepath.Join(dir, "sess", "subagents")
	os.MkdirAll(subs, 0o700)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	session := filepath.Join(dir, "sess.jsonl")
	writeLines(t, session,
		fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","gitBranch":"feature/601-x","timestamp":%q,"message":{"role":"user","content":"Dispatch the agents"}}`, cwd, now),
		fmt.Sprintf(`{"type":"assistant","sessionId":"s","gitBranch":"feature/601-x","effort":"high","timestamp":%q,"message":{"model":"claude-opus-5-5","content":[{"type":"tool_use","id":"call-1","name":"Agent","input":{"description":"Ticket work","subagent_type":"general-purpose"}},{"type":"tool_use","id":"call-2","name":"Agent","input":{"description":"No label #800","subagent_type":"Explore"}}]}}`, now),
	)
	writeLines(t, filepath.Join(subs, "agent-aa1.meta.json"), fmt.Sprintf(`{"toolUseId":"call-1","worktreePath":%q}`, wt))
	writeLines(t, filepath.Join(subs, "agent-aa1.jsonl"), `{"type":"assistant","gitBranch":"fix/954-elsewhere","effort":"low","message":{"model":"claude-haiku-4-5","content":[]}}`)

	start := time.Now().Add(-time.Minute).UnixMilli()
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b": {BlockId: "b", Agent: "claude", Started: start, Running: true}},
		cwds:  map[string]string{"b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	labels := &fakeLabels{calls: map[int]int{}, labels: map[int][]string{601: {"complexity: medium"}, 700: {"complexity: low", "bug"}}}
	m.ticketLabels = labels.lookup
	defer m.Close("b", "v")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: session}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	v := waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session != nil && v.Session.Ticket == 601 && len(v.Subagents) == 2
	})
	time.Sleep(100 * time.Millisecond)
	if calls := labels.count(); len(calls) != 0 {
		t.Fatalf("no gh call without a refresh: %v", calls)
	}
	if v.Session.Model != "claude-opus-5-5" || v.Session.Effort != "high" || v.Subagents[0].Branch != "" {
		t.Errorf("the main agent's facts, and no sub-agent transcript read yet: %+v %+v", v.Session, v.Subagents[0])
	}

	m.Refresh("b")
	v = waitView(t, env, "b", func(v CompanionView) bool {
		return v.Session.Complexity == ComplexityMedium && len(v.Subagents) == 2 && v.Subagents[0].Complexity == ComplexityLow
	})
	sub := v.Subagents[0]
	if sub.Ticket != 700 || sub.Branch != "feature/700-y" || sub.Effort != "low" || sub.Model != "claude-haiku-4-5" {
		t.Errorf("the sub-agent's own transcript: %+v", sub)
	}
	if v.Subagents[1].Ticket != 800 || v.Subagents[1].Complexity != "" {
		t.Errorf("without a branch of its own, the ticket its description names, never the parent's: %+v", v.Subagents[1])
	}
	for i := 0; i < 3; i++ {
		m.Refresh("b")
		time.Sleep(50 * time.Millisecond)
	}
	if calls := labels.count(); calls[601] != 1 || calls[700] != 1 || calls[800] > 1 {
		t.Errorf("one gh call per ticket: %v", calls)
	}
}

// #967, the developer's screenshot: a main agent on develop runs four background sub-agents, each in its own worktree
// on its own branch, while Claude Code records in every transcript the branch another worktree last switched to. Each
// row shows its own ticket; one still on its worktree-agent-… branch takes its description's; one with neither shows
// none, never the parent's or another sub-agent's; the main agent shows none while its topic names none.
func TestSubagentTicketsFromTheirWorktrees(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	makeRepo(t, repo, "develop")
	dir := filepath.Join(root, ClaudeSlug(repo))
	subs := filepath.Join(dir, "sess", "subagents")
	os.MkdirAll(subs, 0o700)
	session := filepath.Join(dir, "sess.jsonl")
	writeLines(t, session, `{}`)
	agents := []struct {
		id, description, branch, recorded string
		want                              int
	}{
		{"a81", "#963 Reviews Launch", "feature/963-reviews-launch", "feature/962-browser-test-context", 963},
		{"af7", "#962 browser test context", "feature/962-browser-test-context", "fix/961-status-bar-detached-head", 962},
		{"a90", "#961 status bar detached", "fix/961-status-bar-detached-head", "feature/960-merged-history", 961},
		{"aa9", "#960 merged PR history", "feature/960-merged-history", "fix/954-reviews-agent-line", 960},
		{"ab1", "#958 just started", "worktree-agent-ab1", "fix/954-reviews-agent-line", 958},
		{"ab2", "Explore the code", "worktree-agent-ab2", "fix/954-reviews-agent-line", 0},
	}
	a := MakeClaudeAdapter([]string{root})
	s := MakeSession()
	at := "2026-10-22T12:00:00.000Z"
	parseRecordLine(a, s, []byte(fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","gitBranch":"feature/962-browser-test-context","timestamp":%q,"message":{"role":"user","content":"Launch the four tickets"}}`, repo, at)))
	for _, ag := range agents {
		wt := filepath.Join(repo, ".claude", "worktrees", "agent-"+ag.id)
		makeWorktree(t, repo, wt, ag.branch)
		callId := "call-" + ag.id
		parseRecordLine(a, s, []byte(fmt.Sprintf(`{"type":"assistant","sessionId":"s","gitBranch":"fix/954-reviews-agent-line","timestamp":%q,"message":{"role":"assistant","content":[{"type":"tool_use","id":%q,"name":"Agent","input":{"description":%q,"subagent_type":"general-purpose","run_in_background":true}}]}}`, at, callId, ag.description)))
		writeLines(t, filepath.Join(subs, "agent-"+ag.id+".meta.json"), fmt.Sprintf(`{"toolUseId":%q,"worktreePath":%q,"description":%q}`, callId, wt, ag.description))
		writeLines(t, filepath.Join(subs, "agent-"+ag.id+".jsonl"), fmt.Sprintf(`{"type":"assistant","cwd":%q,"gitBranch":%q,"message":{"model":"claude-opus-5-5","content":[]}}`, wt, ag.recorded))
	}
	ids := a.SubagentIds(session)
	for _, sa := range s.runningSubagents() {
		s.SetSubagentId(sa.callId, ids[sa.callId])
		if facts, ok := a.ReadSubagent(session, ids[sa.callId]); ok {
			s.SetSubagentFacts(sa.callId, facts)
		}
	}
	s.SetFolderBranch(FolderBranch(s.Cwd))
	s.ResolveTickets(nil)
	got := map[string]SubagentInfo{}
	for _, sub := range s.Subagents() {
		got[sub.Description] = sub
	}
	for _, ag := range agents {
		sub := got[ag.description]
		if sub.Ticket != ag.want || sub.Branch != ag.branch {
			t.Errorf("%q: ticket %d on %q, want %d on %q", ag.description, sub.Ticket, sub.Branch, ag.want, ag.branch)
		}
	}
	if n, _ := s.Ticket(); n != 0 || s.Branch() != "develop" {
		t.Errorf("the main agent on develop with no ticket in its topic: %d on %q", n, s.Branch())
	}
}
