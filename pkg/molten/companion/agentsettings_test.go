// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type settingsSink struct {
	lock sync.Mutex
	got  map[string]molten.AgentSettings
}

func (s *settingsSink) set(blockId string, agent string, settings molten.AgentSettings) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.got[blockId+":"+agent] = settings
}

func (s *settingsSink) of(key string) (molten.AgentSettings, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	v, ok := s.got[key]
	return v, ok
}

// #549: Claude Code's model and effort reach the pane with every status line, whether plan usage shows or not.
func TestStatusLineRecordsTheModelAndEffort(t *testing.T) {
	m, _, _ := gaugesTestManager(t)
	sink := &settingsSink{got: map[string]molten.AgentSettings{}}
	m.setSettings = sink.set
	req := statusLineReport("b1", 10)
	req.Model, req.ModelName, req.Effort = "claude-opus-5-5", "Opus", "xhigh"
	if resp, err := m.HandleStatusLine(req); err != nil || resp.Kept {
		t.Fatalf("plan usage hidden: %+v %v", resp, err)
	}
	if got, _ := sink.of("b1:claude"); got != (molten.AgentSettings{Model: "claude-opus-5-5", ModelName: "Opus", Effort: "xhigh"}) {
		t.Fatalf("recorded: %+v", got)
	}
}

func writeSettingsRollout(t *testing.T, lines ...string) string {
	dir := filepath.Join(t.TempDir(), "sessions", "2026", "10", "12")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-10-12T10-00-00-01a1201f-3c17-7b61-bf5d-0f87263fdfd6.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexReadsTheLastTurnsSettings(t *testing.T) {
	path := writeSettingsRollout(t,
		`{"timestamp":"2026-10-12T10:00:00Z","type":"session_meta","payload":{"id":"01a1201f-3c17-7b61-bf5d-0f87263fdfd6","cwd":"/tmp"}}`,
		`{"timestamp":"2026-10-12T10:00:01Z","type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"low","cwd":"/tmp"}}`,
		`{"timestamp":"2026-10-12T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"turn_context is a word here"}}`,
		`{"timestamp":"2026-10-12T10:05:00Z","type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"high","cwd":"/tmp"}}`,
		`{"timestamp":"2026-10-12T10:05:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}`,
	)
	got, ok := MakeCodexAdapter(nil).ReadSettings(path)
	if !ok || got != (molten.AgentSettings{Model: "gpt-6.1-sol", Effort: "high"}) {
		t.Fatalf("got %+v %v", got, ok)
	}
	noEffort := writeSettingsRollout(t, `{"type":"turn_context","payload":{"model":"gpt-x"}}`)
	if got, ok := MakeCodexAdapter(nil).ReadSettings(noEffort); !ok || got.Effort != "" || got.Model != "gpt-x" {
		t.Fatalf("a turn without effort: %+v %v", got, ok)
	}
	none := writeSettingsRollout(t, `{"type":"session_meta","payload":{}}`)
	if _, ok := MakeCodexAdapter(nil).ReadSettings(none); ok {
		t.Fatal("a rollout without a turn has no settings")
	}
}

// Codex's notify links the session at each turn's end; that report reads the turn's settings for the pane.
func TestCodexSessionReportReadsTheSettings(t *testing.T) {
	path := writeSettingsRollout(t, `{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"medium"}}`)
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(path))))
	m := MakeManager()
	codex := MakeCodexAdapter([]string{root})
	m.adapterFor = func(agent string) Adapter {
		if agent == molten.AgentIdCodex {
			return codex
		}
		return nil
	}
	sink := &settingsSink{got: map[string]molten.AgentSettings{}}
	m.setSettings = sink.set
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Agent: molten.AgentIdCodex, Path: path}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got, ok := sink.of("b1:codex"); ok {
			if got != (molten.AgentSettings{Model: "gpt-6.1-sol", Effort: "medium"}) {
				t.Fatalf("got %+v", got)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the report read no settings")
}
