// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestBuiltinAdapters(t *testing.T) {
	if got := Agents(); !reflect.DeepEqual(got, []string{"claude", "codex"}) {
		t.Fatalf("agents: %v", got)
	}
	cases := map[string]UsagePage{
		"claude": {PageURL: "https://claude.ai/settings/usage", PageName: "Claude usage"},
		"codex":  {PageURL: "https://chatgpt.com/codex/settings/usage", PageName: "Codex usage"},
	}
	for agent, want := range cases {
		page := PageOf(agent)
		if page == nil || *page != want {
			t.Errorf("%s: page %+v, want %+v", agent, page, want)
		}
	}
	if s := For("claude").Sources(); len(s) != 1 || s[0].Id() != ClaudeStatusLineSourceId || !s[0].Documented() {
		t.Errorf("claude: the status line source, documented: %v", s)
	}
	if HasSources(For("codex")) {
		t.Error("codex: no gauges source yet (#263)")
	}
}

func TestUnknownAgentHasNoAdapter(t *testing.T) {
	for _, agent := range []string{"", "gemini", "Claude", "claude "} {
		if For(agent) != nil || PageOf(agent) != nil {
			t.Errorf("%q has no usage adapter", agent)
		}
	}
}

func TestValidatePageURL(t *testing.T) {
	good := []struct{ url, domain string }{
		{"https://claude.ai/settings/usage", "claude.ai"},
		{"https://chatgpt.com/codex/settings/usage", "chatgpt.com"},
		{"https://platform.openai.com/usage", "openai.com"},
		{"https://CLAUDE.ai/settings/usage", "claude.ai"},
	}
	for _, c := range good {
		if err := ValidatePageURL(c.url, c.domain); err != nil {
			t.Errorf("%s on %s: %v", c.url, c.domain, err)
		}
	}
	bad := []struct{ url, domain string }{
		{"http://claude.ai/settings/usage", "claude.ai"},
		{"https://claude.ai.evil.com/settings/usage", "claude.ai"},
		{"https://evilclaude.ai/settings/usage", "claude.ai"},
		{"https://chatgpt.com/codex/settings/usage", "claude.ai"},
		{"https://user:pw@claude.ai/settings/usage", "claude.ai"},
		{"https://claude.ai:8443/settings/usage", "claude.ai"},
		{"javascript:alert(1)", "claude.ai"},
		{"file:///etc/passwd", "claude.ai"},
		{"//claude.ai/settings/usage", "claude.ai"},
		{"", "claude.ai"},
		{"https://claude.ai/settings/usage", ""},
		{"https://localhost/usage", "localhost"},
		{"https://claude.ai/settings/usage", ".ai"},
	}
	for _, c := range bad {
		if err := ValidatePageURL(c.url, c.domain); err == nil {
			t.Errorf("%q on %q must be refused", c.url, c.domain)
		}
	}
}

func TestRegistryRefusesBadAdapters(t *testing.T) {
	cases := map[string][]UsageAdapter{
		"http page":      {&pageAdapter{id: "x", pageURL: "http://x.example.com/usage", pageName: "X usage", domain: "example.com"}},
		"foreign domain": {&pageAdapter{id: "x", pageURL: "https://evil.com/usage", pageName: "X usage", domain: "example.com"}},
		"no id":          {&pageAdapter{pageURL: "https://example.com/usage", pageName: "X usage", domain: "example.com"}},
		"no name":        {&pageAdapter{id: "x", pageURL: "https://example.com/usage", domain: "example.com"}},
		"duplicate":      {MakeClaudeUsageAdapter(), MakeClaudeUsageAdapter()},
		"nil":            {nil},
	}
	for name, adapters := range cases {
		if r, err := MakeRegistry(adapters...); err == nil || r != nil {
			t.Errorf("%s: the registry must refuse it", name)
		}
	}
	r, err := MakeRegistry(&pageAdapter{id: "x", pageURL: "https://usage.example.com/", pageName: "X usage", domain: "example.com"})
	if err != nil || r.For("x") == nil || r.For("claude") != nil {
		t.Fatalf("registry of one adapter: %v", err)
	}
}

type fakeSource struct {
	id      string
	enabled bool
	snap    UsageSnapshot
	err     error
	reads   int
}

func (s *fakeSource) Id() string                                  { return s.id }
func (s *fakeSource) Name() string                                { return "the " + s.id + " source" }
func (s *fakeSource) Documented() bool                            { return true }
func (s *fakeSource) Enabled(settings *wconfig.SettingsType) bool { return s.enabled }
func (s *fakeSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	s.reads++
	return s.snap, s.err
}

func TestMergeSnapshots(t *testing.T) {
	now := int64(1_000_000)
	best := UsageSnapshot{Source: "best", ReadAt: now - 10, Windows: []UsageWindow{
		{Id: WindowSession, UsedPercent: 40, ResetsAt: now + 100},
		{Id: WindowWeek, UsedPercent: 10, ResetsAt: now - 1},
	}}
	second := UsageSnapshot{Source: "second", Plan: "max", ReadAt: now - 50, Windows: []UsageWindow{
		{Id: WindowSession, UsedPercent: 99, ResetsAt: now + 100},
		{Id: WindowModelPrefix + "opus", UsedPercent: 5},
	}, Credits: &UsageCredits{Enabled: true, Used: 3, Limit: 50, Unit: "usd"}}
	unused := UsageSnapshot{Source: "unused", Windows: []UsageWindow{{Id: WindowSession, UsedPercent: 1}}}
	merged, ok := MergeSnapshots("claude", []UsageSnapshot{best, second, unused}, now)
	if !ok {
		t.Fatal("merge gave nothing")
	}
	ids := []string{}
	for _, w := range merged.Windows {
		ids = append(ids, fmt.Sprintf("%s=%v", w.Id, w.UsedPercent))
	}
	if !reflect.DeepEqual(ids, []string{"session=40", "model:opus=5"}) {
		t.Errorf("windows: %v (best source first, expired week dropped)", ids)
	}
	if merged.Source != "best,second" || merged.Plan != "max" || merged.Credits == nil || merged.Credits.Limit != 50 {
		t.Errorf("merged: %+v", merged)
	}
	if merged.Agent != "claude" || merged.ReadAt != now-50 {
		t.Errorf("agent %q, readat %d: the oldest read used", merged.Agent, merged.ReadAt)
	}
	if _, ok := MergeSnapshots("claude", []UsageSnapshot{{Source: "x", Windows: []UsageWindow{{Id: WindowWeek, ResetsAt: now}}}}, now); ok {
		t.Error("only expired windows: nothing to show")
	}
}

func TestReadGauges(t *testing.T) {
	settings := &wconfig.SettingsType{}
	now := int64(1_000_000)
	off := &fakeSource{id: "off"}
	failing := &fakeSource{id: "failing", enabled: true, err: fmt.Errorf("source changed")}
	working := &fakeSource{id: "working", enabled: true, snap: UsageSnapshot{Windows: []UsageWindow{{Id: WindowSession, UsedPercent: 12}}}}
	a := &pageAdapter{id: "claude", sources: []GaugesSource{off, failing, working}}

	res := ReadGauges(context.Background(), a, settings, "b1", now)
	if res.State != GaugesEnabled || res.Snapshot == nil || res.Snapshot.Source != "working" || len(res.Snapshot.Windows) != 1 {
		t.Fatalf("result %+v", res)
	}
	if res.SourceName != "the working source" || res.Reason != "" {
		t.Errorf("named after the source the windows came from: %+v", res)
	}
	if off.reads != 0 {
		t.Error("a source the user did not turn on is never read")
	}

	res = ReadGauges(context.Background(), &pageAdapter{id: "claude", sources: []GaugesSource{off}}, settings, "b1", now)
	if res.State != GaugesOff || res.Snapshot != nil || off.reads != 0 {
		t.Errorf("nothing on: %+v", res)
	}
	res = ReadGauges(context.Background(), &pageAdapter{id: "claude", sources: []GaugesSource{failing}}, settings, "b1", now)
	if res.State != GaugesUnavailable || res.Snapshot != nil || res.Reason != ReasonFailed || res.SourceName != "the failing source" {
		t.Errorf("failing source: %+v", res)
	}
	named := &fakeSource{id: "named", enabled: true, err: Unavailable(ReasonNoPlan)}
	res = ReadGauges(context.Background(), &pageAdapter{id: "claude", sources: []GaugesSource{named, failing}}, settings, "b1", now)
	if res.State != GaugesUnavailable || res.Reason != ReasonNoPlan {
		t.Errorf("the best source's reason: %+v", res)
	}
	expired := &fakeSource{id: "expired", enabled: true, snap: UsageSnapshot{Windows: []UsageWindow{{Id: WindowWeek, ResetsAt: now - 1}}}}
	res = ReadGauges(context.Background(), &pageAdapter{id: "claude", sources: []GaugesSource{expired}}, settings, "b1", now)
	if res.State != GaugesUnavailable || res.Reason != ReasonExpired {
		t.Errorf("only windows past their reset: %+v", res)
	}
	if res := ReadGauges(context.Background(), For("claude"), settings, "b1", now); res.State != GaugesOff {
		t.Errorf("built-in Claude adapter, not turned on: %+v", res)
	}
}

func TestGaugesOptIn(t *testing.T) {
	settings := &wconfig.SettingsType{CompanionUsageGauges: []string{"codex"}}
	if GaugesOn(settings, "claude") || !GaugesOn(settings, "codex") || GaugesOn(nil, "codex") || GaugesOn(settings, "") {
		t.Error("the opt-in is per agent")
	}
	if got := WithGauges([]string{"codex", "claude", "codex", ""}, "claude", false); !reflect.DeepEqual(got, []string{"codex"}) {
		t.Errorf("off: %v", got)
	}
	if got := WithGauges([]string{"codex"}, "claude", true); !reflect.DeepEqual(got, []string{"codex", "claude"}) {
		t.Errorf("on: %v", got)
	}
	if got := WithGauges([]string{"claude"}, "claude", true); !reflect.DeepEqual(got, []string{"claude"}) {
		t.Errorf("on twice: %v", got)
	}
	ctx := context.Background()
	if IsRefresh(ctx) || !IsRefresh(WithRefresh(ctx, true)) || IsRefresh(WithRefresh(ctx, false)) {
		t.Error("refresh flag")
	}
}
