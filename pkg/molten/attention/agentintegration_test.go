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

func TestIntegrationReportDropsControlCharacters(t *testing.T) {
	reports := &integrationReports{reports: map[string]molten.AgentIntegrationReport{}, now: time.Now}
	reports.record(molten.AgentIntegrationReport{BlockId: "b", Agent: "claude", RealPath: "/x\x1b]8;;evil\x07y", StepAside: "a\nb\x9bc"})
	rep, _ := reports.get("b")
	if rep.RealPath != "/x]8;;evily" || rep.StepAside != "abc" {
		t.Fatalf("%q %q", rep.RealPath, rep.StepAside)
	}
}

// Review of #318: the end of a block's run drops its report, so a later run started without the launcher (by full
// path, or with the integration off) is never taken for an integrated one.
func TestRunEndDropsIntegrationReport(t *testing.T) {
	h := makeAgentHarness()
	reports := &integrationReports{reports: map[string]molten.AgentIntegrationReport{}, now: func() time.Time { return h.clock }}
	h.states.onRunEnd = reports.forget
	h.out("b1", cmdMark("claude"))
	reports.record(molten.AgentIntegrationReport{BlockId: "b1", Agent: "claude"})
	h.out("b1", doneMark(0)+promptMark)
	if _, ok := reports.get("b1"); ok {
		t.Fatalf("the run ended: its report must go")
	}
}

// #947: a run's browser server is known from the launcher's report, else from the agent's arguments once MoltenTerm
// restarted and lost the report.
func TestIntegrationRunsFromReportOrArgs(t *testing.T) {
	runs := []molten.AgentRunInfo{
		{BlockId: "b4", Agent: "claude", Running: true},
		{BlockId: "b1", Agent: "claude", Running: true, Pid: 11},
		{BlockId: "b2", Agent: "claude", Running: true, Pid: 12},
		{BlockId: "b3", Agent: "codex", Running: true, Pid: 13},
		{BlockId: "b5", Agent: "claude", Running: false, Pid: 15},
		{BlockId: "b6", Agent: "claude", Running: true, Pid: 16},
	}
	reports := map[string]molten.AgentIntegrationReport{
		"b3": {BlockId: "b3", Agent: "codex", Added: []molten.IntegrationItem{{Kind: molten.IntegrationNotify}},
			Skipped: []molten.IntegrationItem{{Kind: molten.IntegrationBrowser, Reason: "already yours"}}},
		"b6": {BlockId: "b6", Agent: "claude", StepAside: "the integration is turned off"},
	}
	args := map[int32][]string{
		11: {"node", "/opt/claude", "--mcp-config=/d/molten/agent-launch/claude-mcp-ab.json", "--settings", "/d/molten/agent-launch/claude-cd.json"},
		12: {"node", "/opt/claude"},
	}
	reportOf := func(blockId string) (molten.AgentIntegrationReport, bool) {
		rep, ok := reports[blockId]
		return rep, ok
	}
	got := integrationRuns(runs, reportOf, func(pid int32) []string { return args[pid] })
	want := []molten.AgentIntegrationRun{
		{BlockId: "b1", Agent: "claude", Integration: molten.RunIntegrationOn, Browser: molten.RunBrowserAdded},
		{BlockId: "b2", Agent: "claude", Integration: molten.RunIntegrationOff, Browser: molten.RunBrowserNone},
		{BlockId: "b3", Agent: "codex", Integration: molten.RunIntegrationOn, Browser: molten.RunBrowserSkipped, BrowserReason: "already yours"},
		{BlockId: "b4", Agent: "claude", Integration: molten.RunIntegrationUnknown, Browser: molten.RunBrowserUnknown},
		{BlockId: "b6", Agent: "claude", Integration: molten.RunIntegrationOff, Browser: molten.RunBrowserNone},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d runs %+v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i].BlockId != want[i].BlockId || got[i].Integration != want[i].Integration || got[i].Browser != want[i].Browser || got[i].BrowserReason != want[i].BrowserReason {
			t.Errorf("run %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}
