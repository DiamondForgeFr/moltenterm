// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeSubagentDetail(t *testing.T) {
	dir := t.TempDir()
	session := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(session, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	subs := filepath.Join(dir, "s", "subagents")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(subs, "agent-a1b2.jsonl")
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"Find every hardcoded colour"},"timestamp":"2026-10-29T10:00:00.000Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Looking."}]},"timestamp":"2026-10-29T10:00:01.000Z"}`,
		`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"Found 12 colours in 4 files."}]},"timestamp":"2026-10-29T10:00:02.000Z"}`,
	}
	if err := os.WriteFile(transcript, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := MakeClaudeAdapter([]string{dir})
	path, ok := a.SubagentTranscript(session, "a1b2")
	if !ok || path != transcript {
		t.Fatalf("transcript: got %q %v", path, ok)
	}
	if _, ok := a.SubagentTranscript(session, "../escape"); ok {
		t.Fatalf("an agent id that is not one must not name a file")
	}
	if _, ok := a.SubagentTranscript(session, "gone"); ok {
		t.Fatalf("a missing transcript must not be given")
	}
	got := lastMessageOf(a, transcript)
	if !strings.Contains(got, "Found 12 colours in 4 files.") {
		t.Fatalf("last message: got %q", got)
	}
}

func TestSubagentDetailOfWatcher(t *testing.T) {
	dir := t.TempDir()
	session := filepath.Join(dir, "s.jsonl")
	subs := filepath.Join(dir, "s", "subagents")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subs, "agent-x9.jsonl"), []byte(`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"All done."}]}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := MakeSession()
	s.StartSubagent("call-1", "Ticket #1303 rename panel", "general-purpose", "", "", false, 1)
	s.SetSubagentId("call-1", "x9")
	s.StartSubagent("call-2", "No transcript yet", "Explore", "", "", false, 2)
	w := &watcher{adapter: MakeClaudeAdapter([]string{dir}), path: session, session: s}

	d, err := w.subagentDetail("call-1")
	if err != nil {
		t.Fatal(err)
	}
	if d.Transcript != filepath.Join(subs, "agent-x9.jsonl") || !strings.Contains(d.LastMessage, "All done.") {
		t.Fatalf("detail: got %+v", d)
	}
	d, err = w.subagentDetail("call-2")
	if err != nil || d.Transcript != "" || d.LastMessage != "" {
		t.Fatalf("a sub-agent without a transcript gives nothing: got %+v %v", d, err)
	}
	w.session = nil
	if _, err := w.subagentDetail("call-1"); err == nil {
		t.Fatalf("no session must be an error")
	}
}

func TestLastPromptAt(t *testing.T) {
	s := MakeSession()
	if s.LastPromptAt() != 0 {
		t.Fatalf("no prompt yet must give 0")
	}
	s.AddPrompt("first", 10)
	s.AddPrompt("second, no tool used yet", 20)
	if got := s.LastPromptAt(); got != 20 {
		t.Fatalf("last prompt: got %d", got)
	}
}
