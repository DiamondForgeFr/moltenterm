// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// DS-SHELL-051: a launcher's report speaks for the run it was sent for: same agent and process, still running.
func TestIntegrationReportFollowsItsRun(t *testing.T) {
	h := makeAgentHarness()
	reports := &integrationReports{reports: map[string]molten.AgentIntegrationReport{}, now: func() time.Time { return h.clock }}
	current := func(block string) bool {
		rec, ok := h.states.runRecord(block)
		_, found := reports.current(block, rec, ok)
		return found
	}
	h.out("b1", cmdMark("claude"))
	h.clock = h.clock.Add(20 * time.Millisecond)
	added := []molten.IntegrationItem{{Kind: molten.IntegrationStateHooks, Name: "Agent state hooks"}}
	if err := reports.record(molten.AgentIntegrationReport{BlockId: "b1", Agent: "claude", RealPath: "/r/claude", Pid: 42, Added: added}); err != nil {
		t.Fatal(err)
	}
	if !current("b1") {
		t.Fatalf("the report of the run just started")
	}
	h.states.processAgent("b1", molten.AgentProcess{Agent: "claude", Pid: 42, StartMs: h.clock.UnixMilli()}, true)
	if !current("b1") {
		t.Fatalf("the agent's process is the launcher's (exec keeps the pid)")
	}
	h.states.processAgent("b1", molten.AgentProcess{Agent: "claude", Pid: 43, StartMs: h.clock.UnixMilli()}, true)
	if current("b1") {
		t.Fatalf("another process is another run")
	}
	h.out("b1", doneMark(0)+promptMark)
	h.clock = h.clock.Add(time.Minute)
	h.out("b1", cmdMark("/r/claude"))
	if current("b1") {
		t.Fatalf("a later run by full path has no report")
	}
	if current("b2") {
		t.Fatalf("no report for another block")
	}
	reports.record(molten.AgentIntegrationReport{BlockId: "b3", Agent: "claude"})
	if !current("b3") {
		t.Fatalf("a block whose run is not known yet keeps a fresh report")
	}
	h.clock = h.clock.Add(time.Minute)
	if current("b3") {
		t.Fatalf("an untracked report does not last")
	}
	reports.forget("b1")
	if _, ok := reports.get("b1"); ok {
		t.Fatalf("a closed block's report goes")
	}
}

func TestIntegrationReportIsBounded(t *testing.T) {
	reports := &integrationReports{reports: map[string]molten.AgentIntegrationReport{}, now: time.Now}
	if err := reports.record(molten.AgentIntegrationReport{Agent: "claude"}); err == nil {
		t.Fatalf("a report needs a block")
	}
	if err := reports.record(molten.AgentIntegrationReport{BlockId: "b", Agent: "Not An Id"}); err == nil {
		t.Fatalf("a report needs a valid agent")
	}
	var many []molten.IntegrationItem
	for i := 0; i < 100; i++ {
		many = append(many, molten.IntegrationItem{Name: strings.Repeat("x", 2000)})
	}
	reports.record(molten.AgentIntegrationReport{BlockId: "b", Agent: "claude", Added: many, StepAside: strings.Repeat("y", 5000)})
	rep, _ := reports.get("b")
	if len(rep.Added) != maxIntegrationItems || len(rep.Added[0].Name) != maxIntegrationText || len(rep.StepAside) != maxIntegrationText {
		t.Fatalf("clipped: %d %d %d", len(rep.Added), len(rep.Added[0].Name), len(rep.StepAside))
	}
	for i := 0; i < maxIntegrationReports+5; i++ {
		reports.record(molten.AgentIntegrationReport{BlockId: "blk" + strings.Repeat("z", i%7) + string(rune('a'+i%26)) + time.Now().String(), Agent: "claude"})
	}
	if len(reports.reports) > maxIntegrationReports {
		t.Fatalf("%d reports kept", len(reports.reports))
	}
}
