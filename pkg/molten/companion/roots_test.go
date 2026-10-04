// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func privateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	os.Chmod(dir, 0o700)
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func TestExtraSessionRoots(t *testing.T) {
	good := privateDir(t)
	if got := ExtraSessionRoots("claude", []string{good}); len(got) != 1 || got[0] != filepath.Join(good, "projects") {
		t.Errorf("claude root: %v", got)
	}
	if got := ExtraSessionRoots("codex", []string{good, good}); len(got) != 1 || got[0] != filepath.Join(good, "sessions") {
		t.Errorf("codex root, once: %v", got)
	}
	if got := ExtraSessionRoots("gemini", []string{good}); got != nil {
		t.Errorf("no companion for gemini: %v", got)
	}
	file := filepath.Join(good, "file")
	os.WriteFile(file, []byte("x"), 0o600)
	bad := []string{"", "relative/dir", filepath.Join(good, "missing"), file, "/tmp/\x00x"}
	if runtime.GOOS != "windows" {
		shared := privateDir(t)
		os.Chmod(shared, 0o777)
		bad = append(bad, shared)
		groupWritable := privateDir(t)
		os.Chmod(groupWritable, 0o770)
		bad = append(bad, groupWritable)
		// A private folder whose session folder is a link to a folder others can write to.
		linked := privateDir(t)
		open := privateDir(t)
		os.Chmod(open, 0o777)
		os.Symlink(open, filepath.Join(linked, "projects"))
		bad = append(bad, linked)
		if os.Getuid() != 0 {
			bad = append(bad, "/")
		}
	}
	for _, folder := range bad {
		if got := ExtraSessionRoots("claude", []string{folder}); len(got) != 0 {
			t.Errorf("folder %q accepted: %v", folder, got)
		}
	}
	var many []string
	for i := 0; i < maxExtraRoots+3; i++ {
		dir := filepath.Join(good, fmt.Sprintf("d%d", i))
		os.Mkdir(dir, 0o700)
		many = append(many, dir)
	}
	if got := ExtraSessionRoots("claude", many); len(got) != maxExtraRoots {
		t.Errorf("roots capped at %d: %d", maxExtraRoots, len(got))
	}
	// A link to a private folder is the folder.
	link := filepath.Join(privateDir(t), "link")
	os.Symlink(good, link)
	if got := ExtraSessionRoots("claude", []string{link}); len(got) != 1 || got[0] != filepath.Join(good, "projects") {
		t.Errorf("linked folder: %v", got)
	}
}

// The configured folders are session roots for discovery and for hook reports, with the same checks.
func TestConfiguredRootsAcceptReports(t *testing.T) {
	config := privateDir(t)
	defer SetConfiguredRoots(nil)
	SetConfiguredRoots(func() map[string][]string { return map[string][]string{"claude": {config}} })
	a := AdapterFor("claude")
	extra := filepath.Join(config, "projects")
	found := false
	for _, r := range a.Roots() {
		if r == extra {
			found = true
		}
	}
	if !found {
		t.Fatalf("configured root missing: %v", a.Roots())
	}
	good := filepath.Join(extra, "-work-demo", "s.jsonl")
	os.MkdirAll(filepath.Dir(good), 0o700)
	os.WriteFile(good, []byte("{}\n"), 0o600)
	if _, err := ValidateSessionPath(a, good); err != nil {
		t.Errorf("a session under a configured root: %v", err)
	}
	beside := filepath.Join(config, "other", "-work-demo", "s.jsonl")
	os.MkdirAll(filepath.Dir(beside), 0o700)
	os.WriteFile(beside, []byte("{}\n"), 0o600)
	if _, err := ValidateSessionPath(a, beside); err == nil {
		t.Error("only the agent's session folder inside the configured folder is a root")
	}
	m := MakeManager()
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Agent: "claude", Path: good}); err != nil {
		t.Errorf("hook report under a configured root: %v", err)
	}
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b2", Agent: "claude", Path: beside}); err == nil {
		t.Error("hook report outside the roots accepted")
	}
}

// After a restart the agent's run started long ago, and it appends to a session it resumed: the only session written
// since is linked without asking. Another pane's session is never taken.
func TestResumedSessionLinked(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	started := time.Now().Add(-10 * time.Minute)
	resumed := filepath.Join(dir, "resumed.jsonl")
	old := started.Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
	line := fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"earlier"}}`+"\n", cwd, old)
	line += fmt.Sprintf(`{"type":"assistant","sessionId":"s","timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":"resumed answer"}]}}`+"\n", time.Now().UTC().Format(time.RFC3339Nano))
	os.WriteFile(resumed, []byte(line), 0o600)
	stale := filepath.Join(dir, "stale.jsonl")
	os.WriteFile(stale, []byte(line), 0o600)
	os.Chtimes(stale, started.Add(-time.Hour), started.Add(-time.Hour))
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b1": {BlockId: "b1", Agent: "claude", Started: started.UnixMilli(), Running: true}},
		cwds:  map[string]string{"b1": cwd, "b2": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b1", "v")
	defer m.Close("b2", "v")
	m.Open("b1", "v")
	v := waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusLive })
	if v.Session == nil || v.Session.LinkedBy != LinkDiscovery || filepath.Base(v.Session.Path) != "resumed.jsonl" {
		t.Fatalf("resumed session: %+v", v.Session)
	}
	if v.Latest == nil || v.Latest.Markdown != "resumed answer" {
		t.Errorf("latest: %+v", v.Latest)
	}

	// A second pane resumes another session in the same folder: two agents there, the picker, never b1's session.
	env.lock.Lock()
	env.runs["b2"] = molten.AgentRunInfo{BlockId: "b2", Agent: "claude", Started: started.UnixMilli(), Running: true}
	env.lock.Unlock()
	other := filepath.Join(dir, "other.jsonl")
	os.WriteFile(other, []byte(line), 0o600)
	m.Open("b2", "v")
	v2 := waitView(t, env, "b2", func(v CompanionView) bool { return v.Status == StatusChoose })
	for _, c := range v2.Candidates {
		if filepath.Base(c.Path) == "resumed.jsonl" {
			t.Error("another pane's session is offered")
		}
	}
}

// A new agent has no session file before its first prompt: another program's session of the folder, written just now,
// is not taken for a resumed one while the agent is young.
func TestFreshAgentDoesNotTakeAnotherProgramsSession(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	old := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
	line := fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"ide"}}`+"\n", cwd, old)
	os.WriteFile(filepath.Join(dir, "ide.jsonl"), []byte(line), 0o600)
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b1": {BlockId: "b1", Agent: "claude", Started: time.Now().Add(-time.Second).UnixMilli(), Running: true}},
		cwds:  map[string]string{"b1": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b1", "v")
	m.Open("b1", "v")
	v := waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusChoose })
	if v.Session != nil {
		t.Errorf("linked another program's session: %+v", v.Session)
	}
}
