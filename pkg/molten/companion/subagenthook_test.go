// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// #988: the sub-agents the hooks report reach the companion from the terminal's own link only, for its own block,
// and are kept for HookSubagents (#986).
func TestSubagentHookReports(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{}).route())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ForgetHookSubagents(routetest.TerminalBlock) })
	report := map[string]any{"blockid": routetest.TerminalBlock, "agent": "codex", "event": "start", "agentid": "a-1", "agenttype": "explorer"}
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notTerminals, molten.CompanionSubagentCommand, report, "no companion for a remote terminal")
	other := map[string]any{"blockid": "block-other", "agent": "codex", "event": "start"}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.CompanionSubagentCommand, other); !strings.Contains(errStr, "its own block") {
		t.Errorf("for another terminal's block: %q", errStr)
	}
	if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.CompanionSubagentCommand, report); errStr != "" {
		t.Fatalf("own block: %q", errStr)
	}
	stop := map[string]any{"blockid": routetest.TerminalBlock, "agent": "codex", "event": "stop", "agentid": "a-1", "transcriptpath": "/h/sub.jsonl"}
	routetest.Ask(t, link, e.Terminal(), molten.CompanionSubagentCommand, stop)
	if _, errStr := routetest.Ask(t, link, e.Terminal(), molten.CompanionSubagentCommand, map[string]any{"blockid": routetest.TerminalBlock, "event": "bogus"}); !strings.Contains(errStr, "unknown sub-agent event") {
		t.Errorf("an unknown event: %q", errStr)
	}
	got := HookSubagents(routetest.TerminalBlock)
	if len(got) != 2 || got[0].Event != molten.SubagentEventStart || got[0].AgentType != "explorer" || got[1].Event != molten.SubagentEventStop || got[1].TranscriptPath != "/h/sub.jsonl" || got[1].At == 0 {
		t.Fatalf("kept %+v", got)
	}
	ForgetHookSubagents(routetest.TerminalBlock)
	if len(HookSubagents(routetest.TerminalBlock)) != 0 {
		t.Fatal("forgotten with its block")
	}
}

// Bounded: the last reports of a block, and the blocks seen last.
func TestSubagentHookLogBounds(t *testing.T) {
	l := makeSubagentHookLog()
	clock := time.Unix(1_000, 0)
	l.now = func() time.Time { clock = clock.Add(time.Millisecond); return clock }
	for i := 0; i < maxSubagentHookEvents+5; i++ {
		l.add(molten.AgentSubagentRequest{BlockId: "b", Event: molten.SubagentEventStart, AgentId: fmt.Sprintf("a-%d", i)})
	}
	if got := l.list("b"); len(got) != maxSubagentHookEvents || got[0].AgentId != "a-5" {
		t.Fatalf("kept %d, first %+v", len(got), got[0])
	}
	for i := 0; i < maxSubagentHookBlocks; i++ {
		l.add(molten.AgentSubagentRequest{BlockId: fmt.Sprintf("x-%d", i), Event: molten.SubagentEventStop})
	}
	if len(l.list("b")) != 0 || len(l.byBlock) != maxSubagentHookBlocks || len(l.list("x-0")) != 1 {
		t.Fatalf("the oldest block goes first: %d blocks", len(l.byBlock))
	}
}
