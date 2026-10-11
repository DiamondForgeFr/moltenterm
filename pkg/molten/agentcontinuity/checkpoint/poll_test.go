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
	time.Sleep(150 * time.Millisecond)
	busy := reads.Load()
	if busy < 8 {
		t.Fatalf("an agent runs: only %d reads in 150 ms at 10 ms", busy)
	}
	// Wakes while busy do not postpone the poll.
	before := reads.Load()
	for i := 0; i < 30; i++ {
		u.Wake()
		time.Sleep(3 * time.Millisecond)
	}
	if reads.Load()-before < 6 {
		t.Fatalf("frequent wakes starved the poll: %d reads", reads.Load()-before)
	}
}
