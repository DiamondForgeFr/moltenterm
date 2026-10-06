// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestClaudeStatusLineSource(t *testing.T) {
	store := MakeStatusLineStore()
	setup := molten.StatusLineSetup{Snippet: "{}", File: "~/.claude/settings.json", Language: "json"}
	src := MakeClaudeStatusLineSource(store, func(cwd string) molten.StatusLineSetup { return setup })
	a := &pageAdapter{id: "claude", sources: []GaugesSource{src}}
	on := &wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}}
	now := int64(1_738_000_000_000)

	if src.Enabled(&wconfig.SettingsType{}) || !src.Enabled(on) {
		t.Fatal("enabled only when claude is in companion:usagegauges")
	}
	if res := ReadGauges(context.Background(), a, &wconfig.SettingsType{}, "b1", now); res.State != GaugesOff {
		t.Errorf("off: %+v", res)
	}
	if res := ReadGauges(context.Background(), a, on, "b1", now); res.State != GaugesUnavailable || res.Reason != ReasonWaiting {
		t.Errorf("no relay report yet: %+v", res)
	}
	if s := SetupOf(a, on, "/w"); s == nil || s.Snippet != "{}" || s.Source != ClaudeStatusLineSourceId {
		t.Errorf("setup when not configured: %+v", s)
	}
	if SetupOf(a, &wconfig.SettingsType{}, "/w") != nil {
		t.Error("no setup read before the opt-in")
	}
	setup.Configured = true
	if SetupOf(a, on, "/w") != nil {
		t.Error("no setup once configured")
	}

	if !store.Record(molten.AgentStatusLineRequest{BlockId: "b1"}, now) {
		t.Error("a first report is a change")
	}
	if res := ReadGauges(context.Background(), a, on, "b1", now); res.Reason != ReasonNoPlan {
		t.Errorf("no rate_limits (not Pro or Max): %+v", res)
	}
	store.Record(molten.AgentStatusLineRequest{BlockId: "b1", RateLimits: true}, now)
	if res := ReadGauges(context.Background(), a, on, "b1", now); res.Reason != ReasonFormat {
		t.Errorf("rate_limits without a readable window: %+v", res)
	}

	req := molten.AgentStatusLineRequest{
		BlockId:    "b1",
		RateLimits: true,
		FiveHour:   &molten.StatusLineWindow{UsedPercent: 23.5, ResetsAt: 1_738_000_600},
		SevenDay:   &molten.StatusLineWindow{UsedPercent: 41.2, ResetsAt: 1_738_400_000},
	}
	if !store.Record(req, now) {
		t.Error("new windows are a change")
	}
	if store.Record(req, now+500) {
		t.Error("the same windows again are not a change")
	}
	res := ReadGauges(context.Background(), a, on, "b1", now+1000)
	if res.State != GaugesEnabled || res.SourceName != "Claude Code status line" {
		t.Fatalf("enabled: %+v", res)
	}
	got := fmt.Sprintf("%+v", res.Snapshot.Windows)
	want := "[{Id:session Label:Current session UsedPercent:23.5 ResetsAt:1738000600000 WindowMins:300} {Id:week Label:This week UsedPercent:41.2 ResetsAt:1738400000000 WindowMins:10080}]"
	if got != want {
		t.Errorf("windows:\n%s\nwant\n%s", got, want)
	}
	if res.Snapshot.ReadAt != now+500 || res.Snapshot.Source != ClaudeStatusLineSourceId {
		t.Errorf("snapshot: %+v", res.Snapshot)
	}
	if other := ReadGauges(context.Background(), a, on, "b2", now); other.Reason != ReasonWaiting {
		t.Errorf("values are per block: %+v", other)
	}

	res = ReadGauges(context.Background(), a, on, "b1", 1_738_000_600_000)
	if len(res.Snapshot.Windows) != 1 || res.Snapshot.Windows[0].Id != WindowWeek {
		t.Errorf("the session window past its reset is dropped: %+v", res.Snapshot)
	}

	store.Forget("b1")
	if store.Has("b1") {
		t.Error("forgotten")
	}
	store.Record(req, now)
	store.Clear()
	if store.Has("b1") {
		t.Error("cleared")
	}
}

func TestStatusLineStoreIsBounded(t *testing.T) {
	store := MakeStatusLineStore()
	for i := 0; i < maxStatusLineBlocks+5; i++ {
		store.Record(molten.AgentStatusLineRequest{BlockId: fmt.Sprintf("b%d", i)}, int64(i))
	}
	if len(store.records) != maxStatusLineBlocks || store.Has("b0") || !store.Has(fmt.Sprintf("b%d", maxStatusLineBlocks+4)) {
		t.Errorf("%d records kept, oldest evicted", len(store.records))
	}
}
