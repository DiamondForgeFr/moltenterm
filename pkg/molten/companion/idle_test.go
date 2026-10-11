// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-PERF-011: an open companion with no agent to follow waits for its agent state instead of looking 4 times a
// second, and an agent state change wakes it at once.
func TestCompanionIdleWaitsForAgentState(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	os.MkdirAll(filepath.Join(root, ClaudeSlug(cwd)), 0o700)
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{},
		cwds:  map[string]string{"b1": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	m.idleTick = time.Hour
	var looks atomic.Int32
	runOf := m.runOf
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		looks.Add(1)
		return runOf(blockId)
	}
	defer m.Close("b1", "v")
	m.Open("b1", "v")
	waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusNoAgent })
	time.Sleep(200 * time.Millisecond)
	if n := looks.Load(); n > 3 {
		t.Fatalf("no agent: the companion looked %d times in 200 ms", n)
	}
	env.lock.Lock()
	env.runs["b1"] = molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Started: time.Now().UnixMilli(), Running: true}
	env.lock.Unlock()
	m.Poke("b1")
	waitView(t, env, "b1", func(v CompanionView) bool { return v.Status != StatusNoAgent })
	// Following a running agent's session: the fast tick again.
	before := looks.Load()
	time.Sleep(200 * time.Millisecond)
	if n := looks.Load() - before; n < 5 {
		t.Fatalf("a running agent: only %d looks in 200 ms at 10 ms", n)
	}
}
