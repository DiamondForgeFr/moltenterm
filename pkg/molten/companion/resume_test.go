// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestSessionIdFromPath(t *testing.T) {
	const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	for _, tc := range []struct {
		agent, path, want string
	}{
		{"claude", "/h/.claude/projects/-w/" + id + ".jsonl", id},
		{"claude", "/h/.claude/projects/-w/agent-1234.jsonl", ""},
		{"claude", "/h/.claude/projects/-w/s1.jsonl", ""},
		{"codex", "/h/.codex/sessions/2026/10/08/rollout-2026-10-08T10-00-00-" + id + ".jsonl", id},
		{"codex", "/h/.codex/sessions/" + id + ".jsonl", ""},
		{"claude", "/h/x/" + id + ".json", ""},
		{"gemini", "/h/" + id + ".jsonl", ""},
	} {
		if got := SessionIdFromPath(tc.agent, tc.path); got != tc.want {
			t.Errorf("%s %s: got %q, want %q", tc.agent, tc.path, got, tc.want)
		}
	}
}

// A hook's report is sure at once; without one, discovery finds the folder's only session within the wait.
func TestFindResumeSession(t *testing.T) {
	const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	start := time.Now().Add(-time.Minute)
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"b1": {BlockId: "b1", Agent: "claude", Started: start.UnixMilli(), Running: true},
			"b2": {BlockId: "b2", Agent: "claude", Started: start.UnixMilli(), Running: true},
		},
		cwds:  map[string]string{"b1": cwd, "b2": t.TempDir()},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)

	session := filepath.Join(dir, id+".jsonl")
	data, _ := os.ReadFile(filepath.Join("testdata", "claude-session.jsonl"))
	text := strings.ReplaceAll(string(data), `"cwd":"/work/demo"`, fmt.Sprintf("%q:%q", "cwd", cwd))
	text = regexp.MustCompile(`2026-10-04T10:0\d:\d\d\.000Z`).ReplaceAllString(text, time.Now().UTC().Format(time.RFC3339Nano))
	os.WriteFile(session, []byte(text), 0o600)

	got := m.FindResumeSession("b1", "claude", 3*time.Second)
	if !got.Sure || got.LinkedBy != LinkDiscovery || SessionIdFromPath("claude", got.Path) != id {
		t.Fatalf("discovery: %+v", got)
	}
	if m.watcher("b1") != nil {
		t.Errorf("the search left the companion open")
	}

	m.lock.Lock()
	m.reports["b2"] = sessionReport{agent: "claude", path: session, at: time.Now()}
	m.lock.Unlock()
	got = m.FindResumeSession("b2", "claude", 0)
	if !got.Sure || got.LinkedBy != LinkHook || got.Path != session {
		t.Fatalf("hook: %+v", got)
	}
	if got := m.FindResumeSession("b2", "codex", 0); got.Sure {
		t.Errorf("another agent's report counted: %+v", got)
	}

	// A pick made for an earlier run of the pane is not this run's session.
	m.lock.Lock()
	delete(m.reports, "b2")
	m.picks["b2"] = sessionPick{agent: "claude", started: start.UnixMilli() - 60_000, path: session}
	m.lock.Unlock()
	if got := m.FindResumeSession("b2", "claude", 0); got.Sure {
		t.Errorf("a stale pick counted: %+v", got)
	}
}
