// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

func globalTestManager(t *testing.T, home string, read func(ctx context.Context, home string) (usage.UsageSnapshot, error)) (*Manager, *gaugesEnv) {
	m := MakeManager()
	g := &gaugesEnv{}
	m.settings = g.get
	m.publishUsage = g.publish
	m.codexHomeDir = func() string { return home }
	m.readCodexGlobal = read
	return m, g
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
	if len(infos) != 1 || !infos[0].Global || infos[0].BlockId != "" || infos[0].Gauges != usage.GaugesEnabled || infos[0].Snapshot.Plan != "prolite" {
		t.Fatalf("%+v", infos)
	}
	if len(g.published) != 1 || !g.published[0].Global {
		t.Fatalf("published %+v", g.published)
	}
	// The same reading is not published again; the automatic read may not fetch.
	m.GlobalUsage(false)
	if len(g.published) != 1 || len(fetched) != 2 || !fetched[0] || fetched[1] {
		t.Fatalf("published %d, fetched %v", len(g.published), fetched)
	}
}

func TestGlobalCodexUsageOffUnreadableOrAbsent(t *testing.T) {
	m, g := globalTestManager(t, t.TempDir(), func(ctx context.Context, home string) (usage.UsageSnapshot, error) {
		return usage.UsageSnapshot{}, usage.Unavailable(usage.ReasonExpired)
	})
	infos := m.GlobalUsage(false)
	if len(infos) != 1 || infos[0].Gauges != usage.GaugesOff || infos[0].Snapshot != nil {
		t.Fatalf("gauges off: %+v", infos)
	}
	g.settings.CompanionUsageGauges = []string{"codex"}
	infos = m.GlobalUsage(false)
	if infos[0].Gauges != usage.GaugesUnavailable || infos[0].Reason != usage.ReasonExpired || len(g.published) != 2 {
		t.Fatalf("unreadable: %+v, %d published", infos, len(g.published))
	}
	m.codexHomeDir = func() string { return "" }
	if infos := m.GlobalUsage(true); len(infos) != 0 {
		t.Fatalf("no Codex on this computer: %+v", infos)
	}
}
