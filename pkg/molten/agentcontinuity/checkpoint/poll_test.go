// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-PERF-011: the poll sleeps while no agent runs, and an agent state wakes it.
func TestPollSleepsWithoutAgents(t *testing.T) {
	store, _ := makeTestStore(t)
	u := MakeUpdater(store)
	u.pollEvery = 10 * time.Millisecond
	var lock sync.Mutex
	running := false
	var reads atomic.Int32
	u.runs = func() []molten.AgentRunInfo {
		reads.Add(1)
		lock.Lock()
		defer lock.Unlock()
		if !running {
			return nil
		}
		return []molten.AgentRunInfo{{BlockId: "b1", Agent: "claude", Running: true}}
	}
	stop := make(chan struct{})
	defer close(stop)
	go u.Run(stop)
	time.Sleep(150 * time.Millisecond)
	if n := reads.Load(); n > 2 {
		t.Fatalf("no agent: the poll ran %d times", n)
	}
	lock.Lock()
	running = true
	lock.Unlock()
	u.Wake()
	// No read count per duration (#1208): a loaded machine reads less often. A poll that stayed asleep, or that
	// frequent wakes kept postponing, never reaches the count before the deadline.
	waitReads(t, &reads, reads.Load()+8, "an agent runs: the poll stays asleep", nil)
	waitReads(t, &reads, reads.Load()+6, "frequent wakes starved the poll", u.Wake)
}

func waitReads(t *testing.T, reads *atomic.Int32, want int32, what string, each func()) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for reads.Load() < want {
		if time.Now().After(deadline) {
			t.Fatalf("%s: %d reads, want %d", what, reads.Load(), want)
		}
		if each != nil {
			each()
		}
		time.Sleep(3 * time.Millisecond)
	}
}
