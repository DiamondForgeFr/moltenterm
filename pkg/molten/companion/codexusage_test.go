// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

type fakeCodexRun struct {
	lock   sync.Mutex
	calls  int
	result string
}

func (f *fakeCodexRun) run(ctx context.Context) (map[string]any, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls++
	var rtn map[string]any
	json.Unmarshal([]byte(f.result), &rtn)
	return rtn, nil
}

func (f *fakeCodexRun) count() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.calls
}

// useFakeCodex points the built-in Codex sources at this manager's sessions and a fake app-server: a test never runs
// the user's own codex.
func useFakeCodex(t *testing.T, m *Manager, result string) *fakeCodexRun {
	fake := &fakeCodexRun{result: result}
	usage.DefaultCodexUsage.Reset()
	usage.DefaultCodexUsage.SetRun(fake.run)
	usage.DefaultCodexUsage.SetTranscript(m.CodexLimits)
	t.Cleanup(func() {
		usage.DefaultCodexUsage.Reset()
		usage.DefaultCodexUsage.SetRun(usage.RunCodexAppServer)
		usage.DefaultCodexUsage.SetTranscript(nil)
	})
	return fake
}

func codexTokenCount(at time.Time, session float64) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":%g,"window_minutes":300,"resets_at":%d},"secondary":{"used_percent":20,"window_minutes":10080,"resets_at":%d},"credits":{"has_credits":false,"unlimited":false,"balance":null},"plan_type":"plus"}}}`+"\n",
		at.UTC().Format(time.RFC3339Nano), session, at.Add(3*time.Hour).Unix(), at.Add(96*time.Hour).Unix())
}

func waitPublished(t *testing.T, g *gaugesEnv, blockId string, ok func(UsageInfo) bool) UsageInfo {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p := g.publishedFor(blockId)
		if len(p) > 0 && ok(p[len(p)-1]) {
			return p[len(p)-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no matching usage published for %s: %+v", blockId, g.publishedFor(blockId))
	return UsageInfo{}
}

func TestCodexGaugesFromTheFollowedSession(t *testing.T) {
	m, g, home := gaugesTestManager(t)
	root := filepath.Join(home, "codex-sessions")
	m.adapterFor = func(agent string) Adapter {
		if agent == "codex" {
			return MakeCodexAdapter([]string{root})
		}
		return nil
	}
	fake := useFakeCodex(t, m, `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":55,"windowDurationMins":300,"resetsAt":4102444800}}}`)
	now := time.Now()
	dir := filepath.Join(root, now.Format("2006"), now.Format("01"), now.Format("02"))
	os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "rollout-"+now.Format("2006-01-02T15-04-05")+"-0199aaaa.jsonl")
	head := fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":"0199aaaa","timestamp":%q,"cwd":%q,"cli_version":"0.160.0","source":"cli"}}`+"\n"+
		`{"timestamp":%q,"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`+"\n",
		now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), home, now.UTC().Format(time.RFC3339Nano))
	os.WriteFile(path, []byte(head), 0o600)

	if _, err := m.Open("b2", "v"); err != nil {
		t.Fatal(err)
	}
	defer m.Close("b2", "v")
	time.Sleep(100 * time.Millisecond)
	if fake.count() != 0 || len(g.publishedFor("b2")) != 0 {
		t.Fatal("gauges off: nothing read, no process (NFR-SHELL-011)")
	}

	info, err := m.SetUsageGauges("b2", true)
	if err != nil {
		t.Fatal(err)
	}
	if info.Gauges != usage.GaugesEnabled || info.SourceName != "Codex app-server" || info.Snapshot.Windows[0].UsedPercent != 55 || fake.count() != 1 {
		t.Fatalf("no token_count in the session: one app-server read: %+v (%d runs)", info, fake.count())
	}
	if info.Setup != nil || info.PageURL != usage.CodexUsagePageURL {
		t.Errorf("no setup for Codex: %+v", info)
	}

	written := time.Now()
	appendFile(t, path, codexTokenCount(written, 12.5))
	// A publication can name the session log before its windows are read: wait for the one that carries them.
	p := waitPublished(t, g, "b2", func(i UsageInfo) bool {
		return i.SourceName == "Codex session log" && i.Snapshot != nil && len(i.Snapshot.Windows) == 2
	})
	if took := time.Since(written); took > 2*time.Second {
		t.Errorf("shown %v after Codex wrote it (FR-SHELL-029-AC1: 2 s)", took)
	}
	if p.Gauges != usage.GaugesEnabled || p.Snapshot.Windows[0].UsedPercent != 12.5 || p.Snapshot.Windows[1].Label != "This week" {
		t.Fatalf("the session's windows: %+v", p.Snapshot)
	}
	if p.Snapshot.ReadAt != written.UnixMilli() || p.Snapshot.Credits != nil {
		t.Errorf("age from the record; no credits line without credits: %+v", p.Snapshot)
	}
	if fake.count() != 1 {
		t.Errorf("the session's values need no process: %d runs", fake.count())
	}
	if info, _ := m.Usage("b2", false); info.SourceName != "Codex session log" || fake.count() != 1 {
		t.Errorf("read again: %+v", info)
	}

	appendFile(t, path, codexTokenCount(time.Now(), 13))
	waitPublished(t, g, "b2", func(i UsageInfo) bool {
		return i.Snapshot != nil && len(i.Snapshot.Windows) > 0 && i.Snapshot.Windows[0].UsedPercent == 13
	})

	if info, _ := m.SetUsageGauges("b2", false); info.Gauges != usage.GaugesOff {
		t.Errorf("off: %+v", info)
	}
	before := len(g.publishedFor("b2"))
	appendFile(t, path, codexTokenCount(time.Now(), 14))
	time.Sleep(150 * time.Millisecond)
	if len(g.publishedFor("b2")) != before {
		t.Error("hidden: nothing published")
	}
}

func TestCodexGaugesWhenTheSessionIsReadThrough(t *testing.T) {
	m, g, home := gaugesTestManager(t)
	root := filepath.Join(home, "codex-sessions")
	m.adapterFor = func(agent string) Adapter {
		if agent == "codex" {
			return MakeCodexAdapter([]string{root})
		}
		return nil
	}
	fake := useFakeCodex(t, m, `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":21,"windowDurationMins":300,"resetsAt":4102444800}}}`)
	g.write([]string{"codex"})
	m.setUsageVisible("b2", true)
	now := time.Now()
	dir := filepath.Join(root, now.Format("2006"), now.Format("01"), now.Format("02"))
	os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "rollout-"+now.Format("2006-01-02T15-04-05")+"-0199bbbb.jsonl")
	os.WriteFile(path, []byte(fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":"0199bbbb","timestamp":%q,"cwd":%q,"cli_version":"0.160.0"}}`+"\n",
		now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), home)), 0o600)

	if _, err := m.Open("b2", "v"); err != nil {
		t.Fatal(err)
	}
	defer m.Close("b2", "v")
	p := waitPublished(t, g, "b2", func(i UsageInfo) bool { return i.Gauges == usage.GaugesEnabled })
	if p.SourceName != "Codex app-server" || fake.count() != 1 {
		t.Errorf("a session without limits, read through: the app-server fills once: %+v (%d runs)", p, fake.count())
	}
}

func TestCodexLimitsOnlyForCodex(t *testing.T) {
	m, _, _ := gaugesTestManager(t)
	if _, ok := m.CodexLimits("b1"); ok {
		t.Error("no companion open: nothing")
	}
	var s Session
	s.AddCodexRateLimits(nil, 1)
	if lim, rev := s.CodexLimits(); !lim.NoLimits || rev != 1 || s.Version != 0 {
		t.Errorf("a token_count without limits is kept, without touching the view: %+v %d %d", lim, rev, s.Version)
	}
}
