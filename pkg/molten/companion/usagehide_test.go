// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const codexOnlyAppServer = `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":55,"windowDurationMins":300,"resetsAt":4102444800}}}`

// codexSessionTest follows a Codex session whose log holds one token_count, in block b2.
func codexSessionTest(t *testing.T, withLimits bool) (*Manager, *gaugesEnv, *fakeCodexRun, string) {
	m, g, home := gaugesTestManager(t)
	root := filepath.Join(home, "codex-sessions")
	m.adapterFor = func(agent string) Adapter {
		if agent == "codex" {
			return MakeCodexAdapter([]string{root})
		}
		return nil
	}
	fake := useFakeCodex(t, m, codexOnlyAppServer)
	now := time.Now()
	dir := filepath.Join(root, now.Format("2006"), now.Format("01"), now.Format("02"))
	os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "rollout-"+now.Format("2006-01-02T15-04-05")+"-0199cccc.jsonl")
	body := fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":"0199cccc","timestamp":%q,"cwd":%q,"cli_version":"0.160.0"}}`+"\n",
		now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), home)
	if withLimits {
		body += codexTokenCount(now, 12.5)
	}
	os.WriteFile(path, []byte(body), 0o600)
	if _, err := m.Open("b2", "v"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close("b2", "v") })
	waitLimits(t, m, func(l usage.CodexTranscriptLimits) bool { return !l.Loading })
	usage.DefaultCodexUsage.Reset()
	return m, g, fake, path
}

func waitLimits(t *testing.T, m *Manager, ok func(usage.CodexTranscriptLimits) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if lim, _ := m.CodexLimits("b2"); ok(lim) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	lim, _ := m.CodexLimits("b2")
	t.Fatalf("limits never matched: %+v", lim)
}

func TestHidingForgetsTheCodexSessionLogAndShowReadsItAgain(t *testing.T) {
	m, g, fake, path := codexSessionTest(t, true)
	m.setUsageVisible("b2", true)
	if _, err := m.SetUsageGauges("b2", true); err != nil {
		t.Fatal(err)
	}
	g.write([]string{"codex"})
	waitLimits(t, m, func(l usage.CodexTranscriptLimits) bool { return len(l.Records) == 1 })

	info, err := m.SetUsageGauges("b2", false)
	g.write(nil)
	if err != nil || info.Gauges != usage.GaugesOff || info.Snapshot != nil {
		t.Fatalf("hidden: %+v %v", info, err)
	}
	if lim, _ := m.CodexLimits("b2"); len(lim.Records) != 0 || lim.NoLimits {
		t.Fatalf("Hide forgets the session log's values: %+v", lim)
	}

	appendFile(t, path, codexTokenCount(time.Now(), 30))
	time.Sleep(200 * time.Millisecond)
	if lim, _ := m.CodexLimits("b2"); len(lim.Records) != 0 {
		t.Errorf("none is kept while hidden: %+v", lim)
	}

	runs := fake.count()
	info, err = m.SetUsageGauges("b2", true)
	g.write([]string{"codex"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Gauges != usage.GaugesEnabled && info.Reason != usage.ReasonWaiting {
		t.Errorf("shown again: fresh values or waiting: %+v", info)
	}
	waitLimits(t, m, func(l usage.CodexTranscriptLimits) bool {
		return len(l.Records) == 1 && l.Records[0].RateLimits["primary"].(map[string]any)["used_percent"] == 30.0
	})
	p := waitPublished(t, g, "b2", func(i UsageInfo) bool {
		return i.SourceName == "Codex session log" && i.Snapshot.Windows[0].UsedPercent == 30
	})
	if p.Snapshot.Windows[0].UsedPercent != 30 {
		t.Errorf("read again from the log's start, the latest record wins: %+v", p.Snapshot)
	}
	if fake.count() > runs+1 {
		t.Errorf("no burst of processes on show: %d then %d", runs, fake.count())
	}
}

func TestSettingsFileTurningCodexOffForgetsTheSessionLog(t *testing.T) {
	m, g, _, _ := codexSessionTest(t, true)
	m.setUsageVisible("b2", true)
	g.write([]string{"codex"})
	m.settingsChanged(g.get())
	waitLimits(t, m, func(l usage.CodexTranscriptLimits) bool { return len(l.Records) == 1 })
	g.write(nil)
	m.settingsChanged(&wconfig.SettingsType{})
	if lim, _ := m.CodexLimits("b2"); len(lim.Records) != 0 {
		t.Errorf("forgotten: %+v", lim)
	}
	g.write([]string{"codex"})
	m.settingsChanged(g.get())
	waitLimits(t, m, func(l usage.CodexTranscriptLimits) bool { return len(l.Records) == 1 })
}

func TestHidingForgetsTheCodexAppServerValues(t *testing.T) {
	m, g, fake, _ := codexSessionTest(t, false)
	if _, err := m.SetUsageGauges("b2", true); err != nil {
		t.Fatal(err)
	}
	g.write([]string{"codex"})
	info, _ := m.usageFor(usageRequest{BlockId: "b2", Fetch: true})
	if info.SourceName != "Codex app-server" || info.Snapshot == nil || fake.count() != 1 {
		t.Fatalf("the app-server's values: %+v (%d runs)", info, fake.count())
	}
	m.SetUsageGauges("b2", false)
	g.write(nil)
	if info, _ := m.Usage("b2", false); info.Snapshot != nil || info.Gauges != usage.GaugesOff {
		t.Errorf("hidden: %+v", info)
	}
	m.SetUsageGauges("b2", true)
	g.write([]string{"codex"})
	// The values were forgotten: a read that may not call shows the waiting state, not the old values.
	if info, _ := m.usageFor(usageRequest{BlockId: "b2"}); info.Snapshot != nil {
		t.Errorf("shown again from scratch: %+v", info)
	}
}

func TestHidingForgetsTheClaudeStatusLineValues(t *testing.T) {
	m, g, _ := gaugesTestManager(t)
	m.SetUsageGauges("b1", true)
	g.write([]string{"claude"})
	if err := m.RecordStatusLine(statusLineReport("b1", 10)); err != nil {
		t.Fatal(err)
	}
	if !usage.DefaultStatusLineStore.Has("b1") {
		t.Fatal("recorded while shown")
	}
	m.SetUsageGauges("b1", false)
	g.write(nil)
	if usage.DefaultStatusLineStore.Has("b1") {
		t.Error("Hide forgets the status line values")
	}
	m.SetUsageGauges("b1", true)
	g.write([]string{"claude"})
	if info, _ := m.Usage("b1", false); info.Snapshot != nil {
		t.Errorf("shown again from scratch: %+v", info)
	}
}

func TestAutomaticReadsPauseWhileTheWindowIsHidden(t *testing.T) {
	m, g, fake, _ := codexSessionTest(t, false)
	m.SetUsageGauges("b2", true)
	g.write([]string{"codex"})
	usage.DefaultCodexUsage.Reset()
	runs := fake.count()
	// A window that does not show asks without fetch: the app-server never starts for it.
	if info, _ := m.usageFor(usageRequest{BlockId: "b2"}); info.Snapshot != nil || fake.count() != runs {
		t.Errorf("hidden: no process (%d then %d): %+v", runs, fake.count(), info)
	}
	if m.usageIsVisible("b2") {
		t.Error("the window reported hidden")
	}
	// On show, one ask reads once; asking again at once does not start another.
	if info, _ := m.usageFor(usageRequest{BlockId: "b2", Fetch: true}); info.Snapshot == nil || fake.count() != runs+1 {
		t.Errorf("shown: one read: %+v (%d runs)", info, fake.count()-runs)
	}
	m.usageFor(usageRequest{BlockId: "b2", Fetch: true})
	if fake.count() != runs+1 {
		t.Errorf("no burst: %d runs", fake.count()-runs)
	}
	usage.DefaultCodexUsage.Clear()
	m.usageFor(usageRequest{BlockId: "b2"})
	if fake.count() != runs+1 {
		t.Error("hidden again: still no read")
	}
	// A manual Refresh is the user's click, from a window that shows.
	usage.DefaultCodexUsage.Reset()
	if info, _ := m.Usage("b2", true); info.Snapshot == nil || fake.count() != runs+2 {
		t.Errorf("Refresh works: %+v (%d runs)", info, fake.count()-runs)
	}
}

func TestSessionFirstReadStartsNoProcessForAHiddenWindow(t *testing.T) {
	m, g, fake, _ := codexSessionTest(t, false)
	g.write([]string{"codex"})
	time.Sleep(300 * time.Millisecond)
	if fake.count() != 0 {
		t.Errorf("the session read through, window unknown: no process: %d", fake.count())
	}
	usage.DefaultCodexUsage.Reset()
	m.setUsageVisible("b2", true)
	m.usageFor(usageRequest{BlockId: "b2", Fetch: true})
	if fake.count() != 1 {
		t.Errorf("a window that shows asks: one process: %d", fake.count())
	}
}

func TestExperimentalSourceMakesNoCallForAHiddenWindowAndKeepsItsOptInOnHide(t *testing.T) {
	m, env := experimentalTestManager(t)
	m.SetUsageGauges("b1", true)
	m.SetUsageExperimental("b1", true)
	hits := env.ep.hits.Load()
	m.SetUsageGauges("b1", false)
	if !env.gaugesEnv.settings.CompanionUsageClaudeOAuth {
		t.Fatal("Hide keeps the opt-in: it is a separate choice")
	}
	m.SetUsageGauges("b1", true)
	if _, err := usage.DefaultClaudeOAuthSource.Read(usage.WithRefresh(context.Background(), false), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("forgotten on Hide: %v", err)
	}
	time.Sleep(1100 * time.Millisecond)
	m.usageFor(usageRequest{BlockId: "b1"})
	if env.ep.hits.Load() != hits {
		t.Errorf("hidden window: no call (%d then %d)", hits, env.ep.hits.Load())
	}
}
