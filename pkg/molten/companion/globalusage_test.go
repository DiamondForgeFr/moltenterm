// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

func globalTestManager(t *testing.T, home string, read func(ctx context.Context, home string) (usage.UsageSnapshot, error)) (*Manager, *gaugesEnv) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return home }
	m.readCodexGlobal = read
	return m, e.gaugesEnv
}

func globalInfoFor(t *testing.T, infos []UsageInfo, agent string) UsageInfo {
	t.Helper()
	for _, info := range infos {
		if info.Agent == agent {
			return info
		}
	}
	t.Fatalf("no %s global reading: %+v", agent, infos)
	return UsageInfo{}
}

func globalPublicationAgents(g *gaugesEnv) []string {
	g.lock.Lock()
	defer g.lock.Unlock()
	agents := make([]string, len(g.published))
	for i, info := range g.published {
		agents[i] = info.Agent
	}
	return agents
}

// #2074: the Codex gauge is global, like Brokk: it is published without a block, with no Codex terminal open.
func TestGlobalCodexUsagePublishedWithoutABlock(t *testing.T) {
	week := usage.UsageWindow{Id: usage.WindowWeek, Label: "This week", UsedPercent: 9, ResetsAt: time.Now().Add(72 * time.Hour).UnixMilli()}
	var fetched []bool
	m, g := globalTestManager(t, t.TempDir(), func(ctx context.Context, home string) (usage.UsageSnapshot, error) {
		fetched = append(fetched, usage.CanFetch(ctx))
		return usage.UsageSnapshot{Agent: "codex", Source: usage.CodexTranscriptSourceId, Plan: "prolite", Windows: []usage.UsageWindow{week}, ReadAt: 1}, nil
	})
	g.settings.CompanionUsageGauges = []string{"codex"}
	infos := m.GlobalUsage(true)
	info := globalInfoFor(t, infos, "codex")
	if len(infos) != 2 || !info.Global || info.BlockId != "" || info.Gauges != usage.GaugesEnabled || info.Snapshot.Plan != "prolite" {
		t.Fatalf("%+v", infos)
	}
	if len(g.published) != 2 || !globalInfoFor(t, g.published, "codex").Global {
		t.Fatalf("published %+v", g.published)
	}
	// The same readings are not published again; the automatic reads may not fetch.
	m.GlobalUsage(false)
	if len(g.published) != 2 || len(fetched) != 2 || !fetched[0] || fetched[1] {
		t.Fatalf("published %d, fetched %v", len(g.published), fetched)
	}
}

func TestGlobalCodexUsageOffUnreadableOrAbsent(t *testing.T) {
	m, g := globalTestManager(t, t.TempDir(), func(ctx context.Context, home string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{}, usage.Unavailable(usage.ReasonExpired)
	})
	infos := m.GlobalUsage(false)
	info := globalInfoFor(t, infos, "codex")
	if len(infos) != 2 || info.Gauges != usage.GaugesOff || info.Snapshot != nil {
		t.Fatalf("gauges off: %+v", infos)
	}
	g.settings.CompanionUsageGauges = []string{"codex"}
	infos = m.GlobalUsage(false)
	info = globalInfoFor(t, infos, "codex")
	if info.Gauges != usage.GaugesUnavailable || info.Reason != usage.ReasonExpired || len(g.published) != 3 {
		t.Fatalf("unreadable: %+v, %d published", infos, len(g.published))
	}
	m.codexHomeDir = func() string { return "" }
	if infos := m.GlobalUsage(true); len(infos) != 1 || infos[0].Agent != "kimi" || infos[0].Gauges != usage.GaugesOff {
		t.Fatalf("no Codex on this computer: %+v", infos)
	}
}

func TestGlobalUsageAccumulatesCodexAndKimi(t *testing.T) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return t.TempDir() }
	m.readCodexGlobal = func(ctx context.Context, home string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{Agent: "codex", Source: usage.CodexTranscriptSourceId, ReadAt: 1, Windows: []usage.UsageWindow{{Id: usage.WindowWeek, UsedPercent: 20}}}, nil
	}
	e.gaugesEnv.settings.CompanionUsageGauges = []string{"codex", "kimi"}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
	infos := m.GlobalUsage(true)
	if len(infos) != 2 || infos[0].Agent != "codex" || infos[1].Agent != "kimi" {
		t.Fatalf("deterministic provider order: %+v", infos)
	}
	codex := globalInfoFor(t, infos, "codex")
	kimi := globalInfoFor(t, infos, "kimi")
	if codex.Gauges != usage.GaugesEnabled || codex.Snapshot == nil || codex.Snapshot.Windows[0].UsedPercent != 20 {
		t.Errorf("Codex: %+v", codex)
	}
	if !kimi.Global || kimi.BlockId != "" || kimi.Gauges != usage.GaugesEnabled || kimi.Snapshot == nil || kimi.Snapshot.Agent != "kimi" || kimi.SourceName == "" || kimi.PageName != "Kimi Code plans" {
		t.Errorf("Kimi: %+v", kimi)
	}
}

func TestGlobalKimiUsageSurvivesCodexAbsenceOrFailure(t *testing.T) {
	for _, tc := range []struct {
		name  string
		home  string
		read  func(context.Context, string) (usage.UsageSnapshot, error)
		count int
	}{
		{name: "absent", count: 1},
		{name: "failing", home: "fake-codex-home", read: func(context.Context, string) (usage.UsageSnapshot, error) {
			return usage.UsageSnapshot{}, usage.Unavailable(usage.ReasonExpired)
		}, count: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, e := kimiUsageTestManager(t)
			m.codexHomeDir = func() string { return tc.home }
			m.readCodexGlobal = tc.read
			e.gaugesEnv.settings.CompanionUsageGauges = []string{"codex", "kimi"}
			e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
			infos := m.GlobalUsage(true)
			if len(infos) != tc.count {
				t.Fatalf("readings: %+v", infos)
			}
			kimi := globalInfoFor(t, infos, "kimi")
			if kimi.Gauges != usage.GaugesEnabled || kimi.Snapshot == nil {
				t.Errorf("Kimi was suppressed: %+v", kimi)
			}
			if tc.name == "failing" {
				codex := globalInfoFor(t, infos, "codex")
				if codex.Gauges != usage.GaugesUnavailable || codex.Reason != usage.ReasonExpired {
					t.Errorf("Codex failure: %+v", codex)
				}
			}
		})
	}
}

func TestGlobalCodexUsageSurvivesKimiFailure(t *testing.T) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return "fake-codex-home" }
	m.readCodexGlobal = func(context.Context, string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{Agent: "codex", Source: usage.CodexTranscriptSourceId, ReadAt: 1, Windows: []usage.UsageWindow{{Id: usage.WindowWeek, UsedPercent: 30}}}, nil
	}
	e.gaugesEnv.settings.CompanionUsageGauges = []string{"codex", "kimi"}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
	e.status.Store(500)
	infos := m.GlobalUsage(true)
	codex := globalInfoFor(t, infos, "codex")
	kimi := globalInfoFor(t, infos, "kimi")
	if codex.Gauges != usage.GaugesEnabled || codex.Snapshot == nil {
		t.Errorf("Codex was suppressed: %+v", codex)
	}
	if kimi.Gauges != usage.GaugesUnavailable || kimi.Reason == "" || kimi.Snapshot != nil {
		t.Errorf("Kimi failure: %+v", kimi)
	}
}

func TestGlobalKimiUsageRequiresBothOptIns(t *testing.T) {
	for _, tc := range []struct {
		name    string
		gauges  []string
		managed bool
	}{
		{name: "neither"},
		{name: "plan usage only", gauges: []string{"kimi"}},
		{name: "managed source only", managed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, e := kimiUsageTestManager(t)
			m.codexHomeDir = func() string { return "" }
			m.readCodexGlobal = func(context.Context, string) (usage.UsageSnapshot, error) {
				t.Error("Codex read without a home")
				return usage.UsageSnapshot{}, nil
			}
			e.gaugesEnv.settings.CompanionUsageGauges = tc.gauges
			e.gaugesEnv.settings.CompanionUsageKimiOAuth = tc.managed
			infos := m.GlobalUsage(true)
			kimi := globalInfoFor(t, infos, "kimi")
			if len(infos) != 1 || kimi.Gauges != usage.GaugesOff || kimi.Snapshot != nil || kimi.Reason != "" {
				t.Errorf("off without a fabricated reading: %+v", infos)
			}
			if e.ep.hits.Load() != 0 || e.creds.Load() != 0 || e.managed.Load() != 0 {
				t.Errorf("source access while off: requests=%d credentials=%d managed=%d", e.ep.hits.Load(), e.creds.Load(), e.managed.Load())
			}
		})
	}
}

func TestGlobalKimiUsageColdReadThenOneFetchAndCache(t *testing.T) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return "" }
	m.readCodexGlobal = func(context.Context, string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{}, usage.Unavailable(usage.ReasonFailed)
	}
	e.gaugesEnv.settings.CompanionUsageGauges = []string{"kimi"}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
	cold := globalInfoFor(t, m.GlobalUsage(false), "kimi")
	if cold.Gauges != usage.GaugesUnavailable || cold.Reason != usage.ReasonWaiting || cold.Snapshot != nil {
		t.Errorf("cold memory-only read: %+v", cold)
	}
	if e.ep.hits.Load() != 0 || e.creds.Load() != 0 {
		t.Fatalf("cold read fetched: requests=%d credentials=%d", e.ep.hits.Load(), e.creds.Load())
	}
	enabled := globalInfoFor(t, m.GlobalUsage(true), "kimi")
	if enabled.Gauges != usage.GaugesEnabled || enabled.Snapshot == nil || e.ep.hits.Load() != 1 {
		t.Fatalf("consented fetch: %+v, requests=%d", enabled, e.ep.hits.Load())
	}
	m.GlobalUsage(false)
	cached := globalInfoFor(t, m.GlobalUsage(true), "kimi")
	if cached.Gauges != usage.GaugesEnabled || cached.Snapshot == nil || e.ep.hits.Load() != 1 {
		t.Errorf("cache reuse: %+v, requests=%d", cached, e.ep.hits.Load())
	}
}

func TestGlobalAndCompanionKimiReadsShareSingleFlight(t *testing.T) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return "" }
	m.readCodexGlobal = func(context.Context, string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{}, usage.Unavailable(usage.ReasonFailed)
	}
	e.gaugesEnv.settings.CompanionUsageGauges = []string{"kimi"}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	var global []UsageInfo
	var companion UsageInfo
	var companionErr error
	go func() {
		defer wg.Done()
		<-start
		global = m.GlobalUsage(true)
	}()
	go func() {
		defer wg.Done()
		<-start
		companion, companionErr = m.usageFor(usageRequest{BlockId: "b1", Fetch: true})
	}()
	close(start)
	wg.Wait()
	if companionErr != nil || globalInfoFor(t, global, "kimi").Gauges != usage.GaugesEnabled || companion.Gauges != usage.GaugesEnabled {
		t.Errorf("concurrent readings: global=%+v companion=%+v", global, companion)
	}
	if e.ep.hits.Load() != 1 {
		t.Errorf("single-flight requests=%d", e.ep.hits.Load())
	}
}

func TestGlobalUsagePublishesPerProviderAndClearsKimi(t *testing.T) {
	m, e := kimiUsageTestManager(t)
	m.codexHomeDir = func() string { return "fake-codex-home" }
	var percent atomic.Int64
	percent.Store(10)
	m.readCodexGlobal = func(context.Context, string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{Agent: "codex", Source: usage.CodexTranscriptSourceId, ReadAt: 1, Windows: []usage.UsageWindow{{Id: usage.WindowWeek, UsedPercent: float64(percent.Load())}}}, nil
	}
	e.gaugesEnv.settings.CompanionUsageGauges = []string{"codex", "kimi"}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = true
	m.GlobalUsage(true)
	m.GlobalUsage(false)
	if got := globalPublicationAgents(e.gaugesEnv); !slices.Equal(got, []string{"codex", "kimi"}) {
		t.Fatalf("initial and duplicate publications: %v", got)
	}
	percent.Store(20)
	m.GlobalUsage(false)
	if got := globalPublicationAgents(e.gaugesEnv); !slices.Equal(got, []string{"codex", "kimi", "codex"}) {
		t.Fatalf("one provider changed: %v", got)
	}
	e.gaugesEnv.settings.CompanionUsageKimiOAuth = false
	settingsChanged(e.get())
	infos := m.GlobalUsage(false)
	kimi := globalInfoFor(t, infos, "kimi")
	if kimi.Gauges != usage.GaugesOff || kimi.Snapshot != nil {
		t.Errorf("Kimi off: %+v", kimi)
	}
	if got := globalPublicationAgents(e.gaugesEnv); !slices.Equal(got, []string{"codex", "kimi", "codex", "kimi"}) {
		t.Fatalf("only Kimi cleared: %v", got)
	}
	if last := e.published[len(e.published)-1]; last.Agent != "kimi" || last.Gauges != usage.GaugesOff || last.Snapshot != nil {
		t.Errorf("published off: %+v", last)
	}
	m.GlobalUsage(false)
	if got := globalPublicationAgents(e.gaugesEnv); !slices.Equal(got, []string{"codex", "kimi", "codex", "kimi"}) {
		t.Errorf("off is the latest published state: %v", got)
	}
	if e.ep.hits.Load() != 1 || e.creds.Load() != 1 {
		t.Errorf("clearing read the source: requests=%d credentials=%d", e.ep.hits.Load(), e.creds.Load())
	}
}
