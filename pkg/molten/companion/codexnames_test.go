// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	codexNamedThread = "01a165aa-0000-7000-8000-000000000001"
	codexOtherThread = "01a165aa-0000-7000-8000-000000000002"
)

func codexIndexLine(id string, name string) string {
	return fmt.Sprintf(`{"id":%q,"thread_name":%q,"updated_at":"2026-10-23T11:45:14.511497Z"}`, id, name)
}

func TestParseCodexIndex(t *testing.T) {
	tail := []byte(`me":"cut line","id":"` + codexOtherThread + `"}` + "\n" +
		codexIndexLine(codexNamedThread, "Generated title") + "\n" +
		codexIndexLine("not-a-thread", "Ignored") + "\n" +
		`{"id":"` + codexOtherThread + `","thread_name":"  "}` + "\n" +
		codexIndexLine(codexNamedThread, "Fix the login\nflow") + "\n" +
		`{"id":"` + codexOtherThread + `","thread_name":`)
	names := parseCodexIndex(tail, true)
	if len(names) != 1 || names[codexNamedThread] != "Fix the login flow" {
		t.Errorf("the thread's latest name, on one line, and nothing from cut, blank or foreign lines: %v", names)
	}
}

// AC1: a Codex thread shows the name its session index gives it, and its /rename (a later line) replaces it. The
// index is only read: its content and time stay as written.
func TestCodexSessionName(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "sessions")
	rollout := codexRolloutPath(root, time.Now(), codexNamedThread)
	writeCodexLines(t, rollout, codexMeta(codexNamedThread, t.TempDir(), time.Now(), ""))
	a := MakeCodexAdapter([]string{root})
	if _, ok := a.SessionName(rollout, codexNamedThread); ok {
		t.Fatal("no index, no name")
	}
	index := filepath.Join(home, codexSessionIndex)
	writeCodexLines(t, index, codexIndexLine(codexOtherThread, "Another thread"), codexIndexLine(codexNamedThread, "Fix the login flow"))
	if name, ok := a.SessionName(rollout, codexNamedThread); !ok || name != "Fix the login flow" {
		t.Errorf("named from the index: %q %v", name, ok)
	}
	writeCodexLines(t, index, codexIndexLine(codexOtherThread, "Another thread"), codexIndexLine(codexNamedThread, "Fix the login flow"),
		codexIndexLine(codexNamedThread, "Login flow, take 2"))
	before, _ := os.Stat(index)
	if name, _ := a.SessionName(rollout, codexNamedThread); name != "Login flow, take 2" {
		t.Errorf("a /rename wins: %q", name)
	}
	after, _ := os.Stat(index)
	if !before.ModTime().Equal(after.ModTime()) || before.Size() != after.Size() {
		t.Error("the index is never written")
	}
	if _, ok := a.SessionName(rollout, "not-a-thread"); ok {
		t.Error("only a thread id is looked up")
	}
	elsewhere := MakeCodexAdapter([]string{filepath.Join(home, "other-root")})
	if _, ok := elsewhere.SessionName(rollout, codexNamedThread); ok {
		t.Error("only the index next to the root that holds the rollout")
	}
}

// The index's end only: a name written only before the last codexIndexTail bytes is not read.
func TestCodexIndexBoundedRead(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "sessions")
	rollout := codexRolloutPath(root, time.Now(), codexNamedThread)
	writeCodexLines(t, rollout, codexMeta(codexNamedThread, t.TempDir(), time.Now(), ""))
	lines := []string{codexIndexLine(codexNamedThread, "Too old to be read")}
	filler := codexIndexLine(codexOtherThread, "Filler")
	for n := 0; n*len(filler) < codexIndexTail+len(filler); n++ {
		lines = append(lines, filler)
	}
	writeCodexLines(t, filepath.Join(home, codexSessionIndex), lines...)
	a := MakeCodexAdapter([]string{root})
	if name, ok := a.SessionName(rollout, codexNamedThread); ok {
		t.Errorf("read beyond the tail: %q", name)
	}
	if name, _ := a.SessionName(rollout, codexOtherThread); name != "Filler" {
		t.Errorf("the tail is read: %q", name)
	}
}

// The companion of a Codex pane names the session like a Claude Code one, and follows a rename.
func TestCodexNameInCompanion(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "sessions")
	cwd := t.TempDir()
	now := time.Now().Add(-time.Minute)
	rollout := codexRolloutPath(root, now, codexNamedThread)
	writeCodexLines(t, rollout, codexMeta(codexNamedThread, cwd, now, ""), codexUserMessage(now, "Fix the login"))
	index := filepath.Join(home, codexSessionIndex)
	writeCodexLines(t, index, codexIndexLine(codexNamedThread, "Fix the login flow"))
	m, env := makeCodexLinkManager(t, root)
	env.lock.Lock()
	env.runs["b"] = molten.AgentRunInfo{BlockId: "b", Agent: molten.AgentIdCodex, Started: now.UnixMilli(), Running: true}
	env.cwds["b"] = cwd
	env.lock.Unlock()
	defer m.Close("b", "v")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: molten.AgentIdCodex, Path: rollout}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool {
		return v.Session != nil && v.Session.Name == "Fix the login flow" && v.Session.Title == "Fix the login"
	})
	writeCodexLines(t, index, codexIndexLine(codexNamedThread, "Fix the login flow"), codexIndexLine(codexNamedThread, "Login flow, take 2"))
	m.Poke("b")
	waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool {
		return v.Session != nil && v.Session.Name == "Login flow, take 2"
	})
}
