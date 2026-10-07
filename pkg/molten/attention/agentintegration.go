// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What the agent launcher added to each pane's agent run (FR-SHELL-036, DS-SHELL-051), kept in memory: the launcher
// reports before it starts the agent, the companion, the hook offer and `molten agent integration status` read it
// while that run lasts.

const (
	maxIntegrationReports = 1000
	// The launcher reports just before the agent starts; a run that started earlier than this before the report is
	// another one.
	integrationReportSlack = 5 * time.Second
	// Without any run known for the block (no shell integration, process not seen yet), a report holds this long.
	integrationReportUntracked = 30 * time.Second
	maxIntegrationItems        = 16
	maxIntegrationText         = 512
)

type integrationReports struct {
	lock    sync.Mutex
	reports map[string]molten.AgentIntegrationReport
	now     func() time.Time
}

var defaultIntegrationReports = &integrationReports{reports: map[string]molten.AgentIntegrationReport{}, now: time.Now}

// clipText bounds a report's text and drops control characters: it is printed in terminals.
func clipText(s string) string {
	if len(s) > maxIntegrationText {
		s = s[:maxIntegrationText]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
}

func clipItems(items []molten.IntegrationItem) []molten.IntegrationItem {
	if len(items) > maxIntegrationItems {
		items = items[:maxIntegrationItems]
	}
	rtn := make([]molten.IntegrationItem, 0, len(items))
	for _, it := range items {
		rtn = append(rtn, molten.IntegrationItem{Kind: clipText(it.Kind), Name: clipText(it.Name), Reason: clipText(it.Reason)})
	}
	return rtn
}

func clipArgs(args []string) []string {
	if len(args) > maxIntegrationItems {
		args = args[:maxIntegrationItems]
	}
	var rtn []string
	for _, a := range args {
		rtn = append(rtn, clipText(a))
	}
	return rtn
}

func (r *integrationReports) record(report molten.AgentIntegrationReport) error {
	if report.BlockId == "" {
		return fmt.Errorf("no block")
	}
	if !molten.ValidAgentId(report.Agent) {
		return fmt.Errorf("invalid agent name %q", report.Agent)
	}
	report.RealPath = clipText(report.RealPath)
	report.Settings = clipText(report.Settings)
	report.McpConfig = clipText(report.McpConfig)
	report.Args = clipArgs(report.Args)
	report.StepAside = clipText(report.StepAside)
	report.Added = clipItems(report.Added)
	report.Skipped = clipItems(report.Skipped)
	r.lock.Lock()
	defer r.lock.Unlock()
	report.At = r.now().UnixMilli()
	if _, ok := r.reports[report.BlockId]; !ok && len(r.reports) >= maxIntegrationReports {
		r.evictOldestLocked()
	}
	r.reports[report.BlockId] = report
	return nil
}

func (r *integrationReports) evictOldestLocked() {
	oldest := ""
	for id, rep := range r.reports {
		if oldest == "" || rep.At < r.reports[oldest].At {
			oldest = id
		}
	}
	delete(r.reports, oldest)
}

func (r *integrationReports) forget(blockId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.reports, blockId)
}

func (r *integrationReports) get(blockId string) (molten.AgentIntegrationReport, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	rep, ok := r.reports[blockId]
	return rep, ok
}

// current returns a block's report when it speaks for the agent running there now: same agent, still running, and
// the same process (the launcher execs, keeping its pid), else a run that started around the report.
func (r *integrationReports) current(blockId string, rec agentRunRecord, hasRun bool) (molten.AgentIntegrationReport, bool) {
	rep, ok := r.get(blockId)
	if !ok {
		return rep, false
	}
	if !hasRun {
		return rep, r.now().Sub(time.UnixMilli(rep.At)) < integrationReportUntracked
	}
	if !rec.running || rec.agent != rep.Agent {
		return rep, false
	}
	if rec.pid != 0 && rep.Pid != 0 {
		return rep, int(rec.pid) == rep.Pid
	}
	slack := integrationReportSlack.Milliseconds()
	if rec.started < rep.At-slack {
		return rep, false
	}
	// The command line and the process start before the launcher reports; a hook's first report comes later.
	return rep, rec.source == sourceHook || rec.started <= rep.At+slack
}

type agentRunRecord struct {
	agent   string
	running bool
	pid     int32
	started int64
	source  string
}

func (a *agentStates) runRecord(blockId string) (agentRunRecord, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil {
		return agentRunRecord{}, false
	}
	return agentRunRecord{agent: rec.agent, running: rec.running, pid: rec.pid, started: rec.started, source: rec.source}, true
}

// RecordAgentIntegration keeps the launcher's report of a block's next agent run.
func RecordAgentIntegration(report molten.AgentIntegrationReport) error {
	return defaultIntegrationReports.record(report)
}

// AgentIntegration returns the launcher's report for the agent running in a block now.
func AgentIntegration(blockId string) (molten.AgentIntegrationReport, bool) {
	rec, hasRun := defaultAgentStates.runRecord(blockId)
	return defaultIntegrationReports.current(blockId, rec, hasRun)
}

// IsAgentIntegrated tells whether the agent running in a block got MoltenTerm's integration at launch.
func IsAgentIntegrated(blockId string) bool {
	rep, ok := AgentIntegration(blockId)
	return ok && rep.Integrated()
}
