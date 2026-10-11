// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// FR-PERF-012 AC2: wavesrv handles at most one status line a second per pane, and the last one of a burst is the one
// the gauges end on.
func TestStatusLineGateCoalescesABurst(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	g.write([]string{"claude"})
	m.statusLineGap = 150 * time.Millisecond

	resp, err := m.HandleStatusLine(statusLineReport("b1", 10))
	if err != nil || !resp.Kept {
		t.Fatalf("first report: %+v %v", resp, err)
	}
	if p := g.publishedFor("b1"); len(p) != 1 {
		t.Fatalf("the first report is handled at once: %d published", len(p))
	}
	for _, pct := range []float64{11, 12, 13} {
		if resp, err := m.HandleStatusLine(statusLineReport("b1", pct)); err != nil || !resp.Kept {
			t.Fatalf("burst: %+v %v", resp, err)
		}
	}
	if p := g.publishedFor("b1"); len(p) != 1 {
		t.Fatalf("within the gap nothing more is handled: %d published", len(p))
	}
	// Another pane has a gate of its own.
	m.HandleStatusLine(statusLineReport("b3", 50))
	if len(g.publishedFor("b3")) != 1 {
		t.Error("another pane's report is handled at once")
	}

	deadline := time.Now().Add(2 * time.Second)
	for len(g.publishedFor("b1")) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	p := g.publishedFor("b1")
	if len(p) != 2 || p[1].Snapshot == nil || p[1].Snapshot.Windows[0].UsedPercent != 13 {
		t.Fatalf("after the gap, the last report of the burst: %+v", p)
	}
	time.Sleep(2 * m.statusLineGap)
	if n := len(g.publishedFor("b1")); n != 2 {
		t.Errorf("the burst is handled once: %d published", n)
	}

	// Past the gap, a report is handled at once again.
	m.HandleStatusLine(statusLineReport("b1", 14))
	if n := len(g.publishedFor("b1")); n != 3 {
		t.Errorf("after a quiet gap: %d published", n)
	}
}

func TestStatusLineGateAnswers(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	if _, err := m.HandleStatusLine(molten.AgentStatusLineRequest{}); err == nil {
		t.Error("a report without a block is refused")
	}
	resp, err := m.HandleStatusLine(statusLineReport("b1", 10))
	if err != nil || resp.Kept || usage.DefaultStatusLineStore.Has("b1") {
		t.Errorf("plan usage hidden: not kept: %+v %v", resp, err)
	}
	g.write([]string{"claude"})
	g.lock.Lock()
	g.remote["b9"] = true
	g.lock.Unlock()
	if _, err := m.HandleStatusLine(statusLineReport("b9", 1)); err == nil {
		t.Error("a remote terminal's report is refused")
	}
	m.ForgetBlock("b1")
	m.lock.Lock()
	_, had := m.statusLines["b1"]
	m.lock.Unlock()
	if had {
		t.Error("a closed block's gate is dropped")
	}
}
