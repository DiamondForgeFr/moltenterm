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
		own, pane, text string
		want            int
	}{
		{"feature/601-agents", "fix/12-x", "#5", 601},
		{"worktree-agent-abc", "fix/12-login", "#5", 12},
		{"develop", "main", "Fix #77 now", 77},
		{"feature/601", "", "", 601},
		{"feature/abc-601", "", "", 0},
		{"develop", "develop", "a#12 or &#39; or x/#4", 0},
		{"", "", "#12345678901", 0},
	}
	for _, c := range cases {
		if got := resolveTicket(c.own, c.pane, c.text); got != c.want {
			t.Errorf("resolveTicket(%q, %q, %q) = %d, want %d", c.own, c.pane, c.text, got, c.want)
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

func TestReadSubagentFacts(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-work-demo")
	subs := filepath.Join(dir, "sess", "subagents")
	os.MkdirAll(subs, 0o700)
	session := filepath.Join(dir, "sess.jsonl")
	writeLines(t, session, `{}`)
	writeLines(t, filepath.Join(subs, "agent-aa1.meta.json"), `{"agentType":"general-purpose","toolUseId":"call-1"}`)
	writeLines(t, filepath.Join(subs, "agent-bad id.meta.json"), `{"toolUseId":"call-x"}`)
	writeLines(t, filepath.Join(subs, "agent-aa1.jsonl"),
		`{"type":"user","gitBranch":"develop","message":{"role":"user","content":"go"}}`,
		`{"type":"assistant","gitBranch":"feature/601-agents","effort":"high","message":{"model":"claude-sonnet-4-5","content":[]}}`,
		`{"type":"assistant","gitBranch":"feature/601-agents","message":{"model":"<synthetic>","content":[]}}`,
		`not json`,
	)
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
	if n, _ := s.Ticket(); n != 9 || s.Subagents()[0].Ticket != 9 {
		t.Errorf("the pane's branch before the description: main %d, sub %+v", n, s.Subagents()[0])
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
	dir := filepath.Join(root, ClaudeSlug(cwd))
	subs := filepath.Join(dir, "sess", "subagents")
	os.MkdirAll(subs, 0o700)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	session := filepath.Join(dir, "sess.jsonl")
	writeLines(t, session,
		fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","gitBranch":"feature/601-x","timestamp":%q,"message":{"role":"user","content":"Dispatch the agents"}}`, cwd, now),
		fmt.Sprintf(`{"type":"assistant","sessionId":"s","gitBranch":"feature/601-x","effort":"high","timestamp":%q,"message":{"model":"claude-opus-5-5","content":[{"type":"tool_use","id":"call-1","name":"Agent","input":{"description":"Ticket work","subagent_type":"general-purpose"}},{"type":"tool_use","id":"call-2","name":"Agent","input":{"description":"No label #800","subagent_type":"Explore"}}]}}`, now),
	)
	writeLines(t, filepath.Join(subs, "agent-aa1.meta.json"), `{"toolUseId":"call-1"}`)
	writeLines(t, filepath.Join(subs, "agent-aa1.jsonl"), `{"type":"assistant","gitBranch":"feature/700-y","effort":"low","message":{"model":"claude-haiku-4-5","content":[]}}`)

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
	if v.Subagents[1].Ticket != 601 || v.Subagents[1].Complexity != ComplexityMedium {
		t.Errorf("without a branch of its own, the pane's ticket: %+v", v.Subagents[1])
	}
	for i := 0; i < 3; i++ {
		m.Refresh("b")
		time.Sleep(50 * time.Millisecond)
	}
	if calls := labels.count(); calls[601] != 1 || calls[700] != 1 || len(calls) != 2 {
		t.Errorf("one gh call per ticket: %v", calls)
	}
}
