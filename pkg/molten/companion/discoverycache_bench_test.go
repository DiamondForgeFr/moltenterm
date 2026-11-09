// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Synthetic transcripts for the discovery and work folder measures (#2142): never the developer's real ones.

// claudeTestRecord is one Claude Code record of a session working in cwd, padded to about size bytes.
func claudeTestRecord(cwd string, kind string, text string, size int) string {
	pad := ""
	if size > len(text)+200 {
		pad = strings.Repeat("x", size-len(text)-200)
	}
	data, _ := json.Marshal(map[string]any{
		"type": kind, "cwd": cwd, "timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"message": map[string]any{"role": kind, "content": text + pad},
	})
	return string(data)
}

// writeClaudeTestSession writes a session of about size bytes working in cwd.
func writeClaudeTestSession(tb testing.TB, path string, cwd string, size int) {
	tb.Helper()
	var b strings.Builder
	b.WriteString(claudeTestRecord(cwd, "user", "fix the build", 0))
	b.WriteString("\n")
	for b.Len() < size {
		b.WriteString(claudeTestRecord(cwd, "assistant", "working", 8*1024))
		b.WriteString("\n")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		tb.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		tb.Fatal(err)
	}
}

// claudeTestFolder makes a Claude Code session folder for cwd holding n sessions of about size bytes each.
func claudeTestFolder(tb testing.TB, n int, size int) (*ClaudeAdapter, string, []string) {
	tb.Helper()
	root := tb.TempDir()
	cwd := filepath.Join(tb.TempDir(), "project")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		tb.Fatal(err)
	}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	dir := filepath.Join(root, ClaudeSlug(cwd))
	var paths []string
	for i := 0; i < n; i++ {
		path := filepath.Join(dir, fmt.Sprintf("00000000-0000-0000-0000-%012d.jsonl", i))
		writeClaudeTestSession(tb, path, cwd, size)
		paths = append(paths, path)
	}
	return MakeClaudeAdapter([]string{root}), cwd, paths
}

// Discovery of a session folder that did not change: 20 sessions of 600 KB.
func BenchmarkClaudeDiscoverUnchanged(b *testing.B) {
	adapter, cwd, _ := claudeTestFolder(b, 20, 600*1024)
	since := time.Now().Add(-time.Hour)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if got := adapter.Discover(cwd, since); len(got) != 20 {
			b.Fatalf("%d candidates", len(got))
		}
	}
}

// Codex discovery in a day of 40 rollouts of other projects and 2 of this one, 200 KB each.
func BenchmarkCodexDiscoverUnchanged(b *testing.B) {
	root := b.TempDir()
	now := time.Now()
	dir := filepath.Join(root, now.Format("2006"), now.Format("01"), now.Format("02"))
	mine := b.TempDir()
	for i := 0; i < 42; i++ {
		cwd := filepath.Join(root, fmt.Sprintf("other-%d", i))
		if i < 2 {
			cwd = mine
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, `{"type":"session_meta","payload":{"id":"t%d","cwd":%q,"timestamp":%q,"source":"cli"}}`+"\n", i, cwd, now.UTC().Format(time.RFC3339Nano))
		sb.WriteString(`{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}` + "\n")
		for sb.Len() < 200*1024 {
			fmt.Fprintf(&sb, `{"type":"event_msg","payload":{"type":"agent_message","message":%q}}`+"\n", strings.Repeat("w", 4096))
		}
		path := filepath.Join(dir, fmt.Sprintf("rollout-%02d.jsonl", i))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			b.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
			b.Fatal(err)
		}
	}
	adapter := MakeCodexAdapter([]string{root})
	since := now.Add(-time.Hour)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if got := adapter.Discover(mine, since); len(got) != 2 {
			b.Fatalf("%d candidates", len(got))
		}
	}
}

// The work folder of a session whose transcript did not change: 600 KB.
func BenchmarkClaudeWorkFolderUnchanged(b *testing.B) {
	adapter, cwd, paths := claudeTestFolder(b, 1, 600*1024)
	m := MakeManager()
	m.adapterFor = func(string) Adapter { return adapter }
	m.runOf = func(string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, Started: time.Now().Add(-time.Hour).UnixMilli()}, true
	}
	m.recordReport("b1", molten.AgentIdClaude, paths[0], false, LinkHook)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if got := m.PaneWorkFolder("b1", nil); got != cwd {
			b.Fatalf("work folder %q", got)
		}
	}
}
