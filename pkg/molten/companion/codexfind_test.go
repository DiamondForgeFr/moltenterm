// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const testThreadId = "0199a8b2-4c1d-7e3f-9a0b-1c2d3e4f5a6b"

func writeRollout(t *testing.T, root string, day time.Time, id string) string {
	t.Helper()
	dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-"+day.Format("2006-01-02T15-04-05")+"-"+id+".jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"session_meta","payload":{"id":"`+id+`"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// FR-SHELL-038: Codex's notify gives the thread id; its rollout is found by id, today's or a resumed old one, and
// nothing that is not a UUID is looked up.
func TestCodexFindSession(t *testing.T) {
	root := t.TempDir()
	a := MakeCodexAdapter([]string{root})
	recent := writeRollout(t, root, time.Now(), testThreadId)
	if got, ok := a.FindSession(testThreadId); !ok || got != recent {
		t.Fatalf("recent: %q %v", got, ok)
	}
	os.Remove(recent)
	old := writeRollout(t, root, time.Now().AddDate(0, -3, 0), testThreadId)
	writeRollout(t, root, time.Now(), "0199a8b2-4c1d-7e3f-9a0b-000000000000")
	if got, ok := a.FindSession(testThreadId); !ok || got != old {
		t.Fatalf("old: %q %v", got, ok)
	}
	for _, bad := range []string{"", "../../etc", "*", "0199a8b2-4c1d-7e3f-9a0b-1c2d3e4f5a6", testThreadId + "/x"} {
		if _, ok := a.FindSession(bad); ok {
			t.Fatalf("%q must not be looked up", bad)
		}
	}
}

func TestReportSessionById(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b": {BlockId: "b", Agent: "codex", Started: time.Now().Add(-time.Second).UnixMilli(), Running: true}},
		cwds:  map[string]string{"b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	m.adapterFor = func(agent string) Adapter {
		if agent == "codex" {
			return MakeCodexAdapter([]string{root})
		}
		return MakeClaudeAdapter([]string{root})
	}
	path, _ := filepath.EvalSymlinks(writeRollout(t, root, time.Now(), testThreadId))
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "codex", SessionId: testThreadId}); err != nil {
		t.Fatal(err)
	}
	if r, ok := m.report("b"); !ok || r.path != path {
		t.Fatalf("report: %+v %v", r, ok)
	}
	// The next turns report the same id: the block's report is reused, nothing is scanned.
	if !(&CodexAdapter{}).SessionMatches(path, testThreadId) || (&CodexAdapter{}).SessionMatches(path, "0199a8b2-4c1d-7e3f-9a0b-ffffffffffff") {
		t.Fatal("SessionMatches")
	}
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "codex", SessionId: testThreadId}); err != nil {
		t.Fatal(err)
	}
	unknown := "0199a8b2-4c1d-7e3f-9a0b-ffffffffffff"
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "codex", SessionId: unknown}); err == nil {
		t.Fatal("an unknown id is an error")
	}
	writeRollout(t, root, time.Now(), unknown)
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "codex", SessionId: unknown}); err == nil {
		t.Fatal("an id just missed is not looked up again at once")
	}
	later := time.Now().Add(idMissTTL + time.Second)
	m.now = func() time.Time { return later }
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "codex", SessionId: unknown}); err != nil {
		t.Fatalf("after the miss expired: %v", err)
	}
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", SessionId: testThreadId}); err == nil {
		t.Fatal("Claude Code's sessions are reported by path")
	}
}
