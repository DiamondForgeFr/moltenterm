// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"encoding/json"
	"strings"
	"testing"
)

func parseSignalLines(t *testing.T, a Adapter, s *Session, lines ...string) {
	t.Helper()
	for _, line := range lines {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("%v: %s", err, line)
		}
		a.Parse(rec, s)
	}
}

func signalKinds(b MaterialBatch) string {
	var kinds []string
	for _, s := range b.Signals {
		kinds = append(kinds, s.Kind)
	}
	return strings.Join(kinds, ",")
}

// Signal 1 (FR-MAT-001): Claude Code's Artifact result and frame-link record; the call's files map gives the sources.
func TestClaudePublicationSignals(t *testing.T) {
	a := MakeClaudeAdapter([]string{t.TempDir()})
	s := MakeLeanSession()
	parseSignalLines(t, a, s,
		`{"type":"user","sessionId":"s1","gitBranch":"feature/77-x","timestamp":"2026-10-30T10:00:00Z","message":{"role":"user","content":"Publish it"}}`,
		`{"type":"assistant","sessionId":"s1","timestamp":"2026-10-30T10:00:01Z","message":{"content":[{"type":"tool_use","id":"tA","name":"Artifact","input":{"file_path":"/tmp/p/index.html","files":{"img/a.png":"/tmp/p/img/a.png","b.css":{"from":"/tmp/other/b.css"}}}}]}}`,
		`{"type":"user","sessionId":"s1","timestamp":"2026-10-30T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tA","content":"ok"}]},"toolUseResult":{"url":"https://claude.ai/artifact/X1","path":"/tmp/p/index.html","artifact_id":"a-1","title":"Page","updated":true,"files_written":[{"path":"img/c.png","sha256":"0"}]}}`,
		`{"type":"frame-link","sessionId":"s1","path":"/tmp/p/index.html","frameUrl":"https://claude.ai/artifact/X1","title":"Page","timestamp":"2026-10-30T10:00:03Z"}`,
		`{"type":"frame-link","sessionId":"s1","artifactCount":1}`,
		`{"type":"assistant","sessionId":"s1","timestamp":"2026-10-30T10:00:04Z","message":{"content":[{"type":"text","text":"Done: https://claude.ai/artifact/X1 and /tmp/p/shot.png"}]}}`,
		`{"type":"system","subtype":"turn_duration","sessionId":"s1"}`,
	)
	b := s.MaterialSignals(0)
	if got := signalKinds(b); got != "published,published,links,answer,turnend" {
		t.Fatalf("signals %s", got)
	}
	pub := b.Signals[0]
	if pub.Url != "https://claude.ai/artifact/X1" || pub.ArtifactId != "a-1" || !pub.Updated || pub.Title != "Page" {
		t.Errorf("publication %+v", pub)
	}
	if strings.Join(pub.Files, ",") != "b.css,img/a.png,img/c.png" || pub.Sources["b.css"] != "/tmp/other/b.css" {
		t.Errorf("files %v sources %v", pub.Files, pub.Sources)
	}
	if b.Ticket != 77 || b.SessionId != "s1" || b.Subject != "Publish it" {
		t.Errorf("batch %+v", b)
	}
	if !strings.Contains(b.Signals[3].Text, "/tmp/p/shot.png") {
		t.Errorf("answer %+v", b.Signals[3])
	}
	if after := s.MaterialSignals(b.Seq); len(after.Signals) != 0 {
		t.Errorf("signals are taken once: %+v", after.Signals)
	}
	if s.turnsEnded != 0 {
		t.Errorf("Claude Code's turn end is its hook's: the transcript's does not end the turn")
	}
}

// Codex: an apply_patch addition is a written file, the last message of a turn its answer.
func TestCodexSignals(t *testing.T) {
	a := MakeCodexAdapter([]string{t.TempDir()})
	s := MakeLeanSession()
	parseSignalLines(t, a, s,
		`{"type":"session_meta","payload":{"id":"c1","cwd":"/work"}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"go"}}`,
		`{"type":"event_msg","payload":{"type":"patch_apply_begin","call_id":"p1","changes":{"notes/a.md":{"add":{"content":"x"}},"b.md":{"update":{"unified_diff":""}}}}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"See /work/notes/a.md"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_complete"}}`,
	)
	b := s.MaterialSignals(0)
	if got := signalKinds(b); got != "written,answer,turnend" {
		t.Fatalf("signals %s", got)
	}
	if b.Signals[0].Path != "/work/notes/a.md" {
		t.Errorf("written %+v", b.Signals[0])
	}
}

// The companion's own sessions keep no signals: only the checkpoint's lean reader feeds the registry.
func TestOnlyLeanSessionsKeepSignals(t *testing.T) {
	s := MakeSession()
	s.NotePublication(Publication{Path: "/tmp/a.html", Url: "https://claude.ai/artifact/A"}, 1)
	s.AddText("https://claude.ai/artifact/B", 2)
	s.EndTurn()
	if b := s.MaterialSignals(0); len(b.Signals) != 0 {
		t.Errorf("signals %+v", b.Signals)
	}
}

func TestSignalBounds(t *testing.T) {
	s := MakeLeanSession()
	for i := 0; i < MaxMaterialSignals+50; i++ {
		s.StartTurn(int64(i))
		s.AddText(strings.Repeat("x", 4000), int64(i))
	}
	b := s.MaterialSignals(0)
	if len(b.Signals) != MaxMaterialSignals {
		t.Fatalf("%d signals", len(b.Signals))
	}
	total := 0
	for _, sig := range b.Signals {
		total += len(sig.Text)
	}
	if total > maxSignalTextBytes {
		t.Errorf("texts kept: %d bytes", total)
	}
	if b.Signals[len(b.Signals)-1].Seq != b.Seq {
		t.Errorf("the newest signals are kept")
	}
}
