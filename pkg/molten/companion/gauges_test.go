// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

type gaugesEnv struct {
	lock      sync.Mutex
	settings  wconfig.SettingsType
	writes    int
	published []UsageInfo
	remote    map[string]bool
}

func (g *gaugesEnv) get() *wconfig.SettingsType {
	g.lock.Lock()
	defer g.lock.Unlock()
	s := g.settings
	return &s
}

func (g *gaugesEnv) write(agents []string) error {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.writes++
	g.settings.CompanionUsageGauges = agents
	return nil
}

func (g *gaugesEnv) publish(info UsageInfo) {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.published = append(g.published, info)
}

func (g *gaugesEnv) publishedFor(blockId string) []UsageInfo {
	g.lock.Lock()
	defer g.lock.Unlock()
	var rtn []UsageInfo
	for _, p := range g.published {
		if p.BlockId == blockId {
			rtn = append(rtn, p)
		}
	}
	return rtn
}

// The settings MoltenTerm reads for the snippet are the test's, never the user's own ~/.claude.
func gaugesTestManager(t *testing.T) (*Manager, *gaugesEnv, string) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	usage.DefaultStatusLineStore.Clear()
	t.Cleanup(usage.DefaultStatusLineStore.Clear)
	start := time.Now().Add(-time.Second).UnixMilli()
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"b1": {BlockId: "b1", Agent: "claude", Started: start, Running: true},
			"b2": {BlockId: "b2", Agent: "codex", Started: start, Running: true},
			"b3": {BlockId: "b3", Agent: "claude", Started: start, Running: true},
		},
		cwds:  map[string]string{"b1": home, "b2": home, "b3": home},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, t.TempDir())
	g := &gaugesEnv{remote: map[string]bool{}}
	m.settings = g.get
	m.writeGauges = g.write
	m.publishUsage = g.publish
	m.blockInfo = func(blockId string) (blockInfo, error) {
		g.lock.Lock()
		defer g.lock.Unlock()
		return blockInfo{cwd: home, term: true, remote: g.remote[blockId]}, nil
	}
	return m, g, home
}

func statusLineReport(blockId string, session float64) molten.AgentStatusLineRequest {
	resets := time.Now().Add(2 * time.Hour).Unix()
	return molten.AgentStatusLineRequest{
		BlockId:    blockId,
		RateLimits: true,
		FiveHour:   &molten.StatusLineWindow{UsedPercent: session, ResetsAt: resets},
		SevenDay:   &molten.StatusLineWindow{UsedPercent: 41, ResetsAt: time.Now().Add(72 * time.Hour).Unix()},
	}
}

func TestPlanGaugesAreOptInPerAgent(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	if _, err := m.Open("b3", "v"); err != nil {
		t.Fatal(err)
	}
	defer m.Close("b3", "v")

	info, err := m.Usage("b1", false)
	if err != nil || info.Gauges != usage.GaugesOff || !info.HasGauges || info.Setup != nil || info.Snapshot != nil {
		t.Fatalf("off by default: %+v %v", info, err)
	}
	if info, _ := m.Usage("b2", false); !info.HasGauges || info.Gauges != usage.GaugesOff {
		t.Errorf("Codex offers its gauges, off by default: %+v", info)
	}

	// Before the opt-in, what the relay sends is dropped (NFR-SHELL-011).
	if err := m.RecordStatusLine(statusLineReport("b1", 10)); err != nil {
		t.Fatal(err)
	}
	if usage.DefaultStatusLineStore.Has("b1") || len(g.publishedFor("b1")) != 0 {
		t.Error("nothing is kept or published before the opt-in")
	}

	info, err = m.SetUsageGauges("b1", true)
	if err != nil || !slices.Equal(g.get().CompanionUsageGauges, []string{"claude"}) {
		t.Fatalf("on: %+v %v (settings %v)", info, err, g.get().CompanionUsageGauges)
	}
	if info.Gauges != usage.GaugesUnavailable || info.Reason != usage.ReasonNotSetUp || info.Setup == nil {
		t.Errorf("on without the relay: the setup shows: %+v", info)
	}
	if info.Setup != nil && (info.Setup.File != "~/.claude/settings.json" || info.Setup.Language != "json" || info.Setup.Snippet == "") {
		t.Errorf("setup: %+v", info.Setup)
	}
	if p := g.publishedFor("b3"); len(p) != 1 || p[0].Reason != usage.ReasonNotSetUp {
		t.Errorf("the other Claude Code companion follows: %+v", p)
	}
	if len(g.publishedFor("b2")) != 0 {
		t.Error("Codex's companion is not affected")
	}

	if err := m.RecordStatusLine(statusLineReport("b1", 23.5)); err != nil {
		t.Fatal(err)
	}
	p := g.publishedFor("b1")
	if len(p) != 1 || p[0].Gauges != usage.GaugesEnabled || p[0].Setup != nil || len(p[0].Snapshot.Windows) != 2 {
		t.Fatalf("the relay's report is published at once: %+v", p)
	}
	if w := p[0].Snapshot.Windows[0]; w.Id != usage.WindowSession || w.UsedPercent != 23.5 || w.Label != "Current session" {
		t.Errorf("session window: %+v", w)
	}
	if p[0].SourceName != "Claude Code status line" || p[0].PageURL != usage.ClaudeUsagePageURL {
		t.Errorf("info: %+v", p[0])
	}
	m.RecordStatusLine(statusLineReport("b1", 23.5))
	if len(g.publishedFor("b1")) != 1 {
		t.Error("unchanged windows are not published again at once")
	}
	m.RecordStatusLine(statusLineReport("b1", 24))
	if len(g.publishedFor("b1")) != 2 {
		t.Error("changed windows are published")
	}
	if info, _ := m.Usage("b3", false); info.Reason != usage.ReasonNotSetUp {
		t.Errorf("values are per terminal: %+v", info)
	}

	info, err = m.SetUsageGauges("b1", false)
	if err != nil || info.Gauges != usage.GaugesOff || len(g.get().CompanionUsageGauges) != 0 {
		t.Fatalf("off: %+v %v", info, err)
	}
	if usage.DefaultStatusLineStore.Has("b1") {
		t.Error("hiding plan usage clears what was read")
	}
}

func TestPlanGaugesReasons(t *testing.T) {
	m, g, home := gaugesTestManager(t)
	g.write([]string{"claude"})

	settings := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settings), 0755)
	os.WriteFile(settings, []byte(`{"statusLine":{"type":"command","command":"`+molten.StatusLineRelayCommand("")+`"}}`), 0644)
	if info, _ := m.Usage("b1", false); info.Reason != usage.ReasonWaiting || info.Setup != nil {
		t.Errorf("relay set up, no report yet: %+v", info)
	}
	m.RecordStatusLine(molten.AgentStatusLineRequest{BlockId: "b1"})
	if info, _ := m.Usage("b1", false); info.Gauges != usage.GaugesUnavailable || info.Reason != usage.ReasonNoPlan {
		t.Errorf("free plan: %+v", info)
	}
	m.RecordStatusLine(molten.AgentStatusLineRequest{BlockId: "b1", RateLimits: true})
	if info, _ := m.Usage("b1", false); info.Reason != usage.ReasonFormat {
		t.Errorf("unreadable: %+v", info)
	}
	past := statusLineReport("b1", 50)
	past.FiveHour.ResetsAt = time.Now().Add(-time.Minute).Unix()
	past.SevenDay = nil
	m.RecordStatusLine(past)
	if info, _ := m.Usage("b1", false); info.Reason != usage.ReasonExpired || info.Snapshot != nil {
		t.Errorf("only a window past its reset: %+v", info)
	}

	g.lock.Lock()
	g.remote["b9"] = true
	g.lock.Unlock()
	if err := m.RecordStatusLine(statusLineReport("b9", 1)); err == nil || usage.DefaultStatusLineStore.Has("b9") {
		t.Error("a remote terminal's report is refused")
	}
	if err := m.RecordStatusLine(molten.AgentStatusLineRequest{}); err == nil {
		t.Error("a report without a block is refused")
	}
}

// Values that stopped coming show with their age while the settings still run the relay, and give way to the setup
// once the user took the relay out.
func TestPlanGaugesStaleValues(t *testing.T) {
	m, g, home := gaugesTestManager(t)
	g.write([]string{"claude"})
	settings := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settings), 0755)
	os.WriteFile(settings, []byte(`{"statusLine":{"type":"command","command":"`+molten.StatusLineRelayCommand("")+`"}}`), 0644)
	start := time.Now()
	report := statusLineReport("b1", 30)
	report.FiveHour.ResetsAt = start.Add(5 * time.Hour).Unix()
	m.RecordStatusLine(report)

	m.now = func() time.Time { return start.Add(usageStaleAfter - time.Minute) }
	if info, _ := m.Usage("b1", false); info.Gauges != usage.GaugesEnabled {
		t.Errorf("recent values: %+v", info)
	}
	m.now = func() time.Time { return start.Add(usageStaleAfter + time.Minute) }
	if info, _ := m.Usage("b1", false); info.Gauges != usage.GaugesEnabled || info.Snapshot == nil {
		t.Errorf("old values, relay still set up: shown with their age: %+v", info)
	}
	os.WriteFile(settings, []byte(`{"statusLine":{"type":"command","command":"echo mine"}}`), 0644)
	info, _ := m.Usage("b1", false)
	if info.Gauges != usage.GaugesUnavailable || info.Reason != usage.ReasonNotSetUp || info.Setup == nil || info.Snapshot != nil {
		t.Errorf("old values, relay removed: the setup again: %+v", info)
	}
	if info.Setup != nil && info.Setup.Current != "echo mine" {
		t.Errorf("the setup wraps the command now in effect: %+v", info.Setup)
	}
}

func TestPlanGaugesClearedWhenTurnedOffInSettings(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	g.write([]string{"claude"})
	m.RecordStatusLine(statusLineReport("b1", 5))
	settingsChanged(&wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}})
	if !usage.DefaultStatusLineStore.Has("b1") {
		t.Fatal("still on: kept")
	}
	settingsChanged(&wconfig.SettingsType{})
	if usage.DefaultStatusLineStore.Has("b1") {
		t.Error("removed from settings.json by hand: cleared")
	}
	m.RecordStatusLine(statusLineReport("b1", 5))
	m.ForgetBlock("b1")
	if usage.DefaultStatusLineStore.Has("b1") {
		t.Error("a closed terminal's values are forgotten")
	}
}

func TestPlanGaugesRoute(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	l := &routeLink{m: m}
	tab := "tab:t1"
	if _, err := l.handle(molten.CompanionUsageGaugesCommand, "block:b1", map[string]any{"blockid": "b1", "on": true}); err == nil {
		t.Error("only a window turns gauges on")
	}
	out, err := l.handle(molten.CompanionUsageGaugesCommand, tab, map[string]any{"blockid": "b1", "on": true})
	if err != nil || out.(UsageInfo).Reason != usage.ReasonNotSetUp {
		t.Fatalf("window: %+v %v", out, err)
	}
	if _, err := l.handle(molten.AgentStatusLineCommand, "conn:host", map[string]any{"blockid": "b1"}); err == nil {
		t.Error("a remote host's relay is refused")
	}
	if _, err := l.handle(molten.AgentStatusLineCommand, "block:b1", statusLineReport("b1", 7)); err != nil {
		t.Errorf("a terminal's relay: %v", err)
	}
	out, err = l.handle(molten.CompanionUsageCommand, tab, map[string]any{"blockid": "b1", "refresh": true})
	if err != nil || out.(UsageInfo).Gauges != usage.GaugesEnabled {
		t.Errorf("usage: %+v %v", out, err)
	}
	if g.writes != 1 {
		t.Errorf("one settings write: %d", g.writes)
	}
}
