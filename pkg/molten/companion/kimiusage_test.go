// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const companionKimiToken = "kimi-FAKE-companion-managed-token-0123456789"

type kimiUsageEnv struct {
	*gaugesEnv
	ep       *fakeUsageEndpoint
	status   atomic.Int32
	managed  atomic.Int32
	creds    atomic.Int32
	settings map[string]any
}

func (e *kimiUsageEnv) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.ep.hits.Add(1)
	if status := e.status.Load(); status != 0 {
		w.WriteHeader(int(status))
		return
	}
	if r.Method != http.MethodGet || r.URL.Path != "/coding/v1/usages" || r.Header.Get("Authorization") != "Bearer "+companionKimiToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{
		"usages": {
			"limit_5h":{"used_ratio":0.2,"reset_time":"2099-01-01T01:00:00Z"},
			"limit_7d":{"used_ratio":0.4,"reset_time":"2099-01-02T01:00:00Z"},
			"limit_month_total":{"used_ratio":0.6,"reset_time":"2099-02-01T00:00:00Z"},
			"limit_month_code":{"used_ratio":0.9,"reset_time":"2099-02-01T00:00:00Z"}
		},
		"boosterWallet": {
			"balance":{"type":"BOOSTER","amount":10000000000,"amountLeft":1234500000},
			"monthlyChargeLimitEnabled":true,
			"monthlyChargeLimit":{"priceInCents":2000,"currency":"USD"},
			"monthlyUsed":{"priceInCents":543,"currency":"USD"}
		}
	}`)
}

func kimiUsageTestManager(t *testing.T) (*Manager, *kimiUsageEnv) {
	home := t.TempDir()
	start := time.Now().Add(-time.Second).UnixMilli()
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"b1": {BlockId: "b1", Agent: "kimi", Started: start, Running: true},
			"b2": {BlockId: "b2", Agent: "codex", Started: start, Running: true},
			"b3": {BlockId: "b3", Agent: "kimi", Started: start, Running: true},
		},
		cwds:  map[string]string{"b1": home, "b2": home, "b3": home},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, t.TempDir())
	g := &gaugesEnv{remote: map[string]bool{}}
	e := &kimiUsageEnv{gaugesEnv: g, ep: &fakeUsageEndpoint{}, settings: map[string]any{}}
	m.settings = g.get
	m.writeGauges = g.write
	m.publishUsage = g.publish
	m.writeSetting = func(key string, value any) error {
		g.lock.Lock()
		defer g.lock.Unlock()
		e.settings[key] = value
		g.settings.CompanionUsageKimiOAuth = value == true
		return nil
	}
	srv := httptest.NewTLSServer(e)
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	usage.DefaultKimiOAuthSource.Clear()
	usage.DefaultKimiOAuthSource.Resume()
	t.Cleanup(usage.DefaultKimiOAuthSource.UseForTest(usage.KimiOAuthTestHooks{
		Endpoint: srv.URL + "/coding/v1/usages",
		Client:   client,
		Credentials: func(context.Context) (string, int64, error) {
			e.creds.Add(1)
			return companionKimiToken, 0, nil
		},
		Store: func() string { return "the Kimi test store" },
		Managed: func() error {
			e.managed.Add(1)
			return nil
		},
	}))
	t.Cleanup(usage.DefaultKimiOAuthSource.Clear)
	return m, e
}

func TestKimiUsageRequiresBothOptIns(t *testing.T) {
	m, env := kimiUsageTestManager(t)
	if _, err := m.Open("b3", "v"); err != nil {
		t.Fatal(err)
	}
	defer m.Close("b3", "v")
	if info, err := m.Usage("b1", false); err != nil || !info.HasGauges || info.Gauges != usage.GaugesOff || info.Experimental != nil {
		t.Fatalf("off: %+v %v", info, err)
	}
	if _, err := m.SetUsageExperimental("b1", true); err == nil {
		t.Error("the source cannot be enabled before plan usage")
	}
	if env.ep.hits.Load() != 0 || env.creds.Load() != 0 || env.managed.Load() != 0 || len(env.settings) != 0 {
		t.Fatal("nothing read, requested or written before both opt-ins")
	}
	info, err := m.SetUsageGauges("b1", true)
	if err != nil || info.Experimental == nil || info.Experimental.On || info.Experimental.Store != "the Kimi test store" {
		t.Fatalf("source offered off: %+v %v", info, err)
	}
	if env.ep.hits.Load() != 0 || env.creds.Load() != 0 || env.managed.Load() != 0 || len(env.settings) != 0 {
		t.Fatal("the first opt-in alone reads nothing")
	}
	info, err = m.SetUsageExperimental("b1", true)
	if err != nil || !info.Experimental.On || info.Experimental.Reason != "" {
		t.Fatalf("second opt-in: %+v %v", info, err)
	}
	if len(env.settings) != 1 || env.settings["companion:usagekimioauth"] != true {
		t.Errorf("only the source opt-in was written: %+v", env.settings)
	}
	if env.ep.hits.Load() != 1 || env.creds.Load() == 0 || env.managed.Load() == 0 {
		t.Errorf("one managed fetch: hits=%d credentials=%d config=%d", env.ep.hits.Load(), env.creds.Load(), env.managed.Load())
	}
	if info.Snapshot == nil || len(info.Snapshot.Windows) != 3 || info.Snapshot.Windows[2].Id != usage.WindowMonth {
		t.Fatalf("all and only the three supported windows: %+v", info.Snapshot)
	}
	credits := info.Snapshot.Credits
	if credits == nil || credits.Balance != "12.35" || credits.Monthly == nil || credits.Monthly.Used != 5.43 || credits.Monthly.Limit != 20 || !credits.Monthly.LimitEnabled {
		t.Errorf("booster and monthly together: %+v", credits)
	}
	published := env.publishedFor("b3")
	if len(published) == 0 || published[len(published)-1].Snapshot == nil || len(published[len(published)-1].Snapshot.Windows) != 3 {
		t.Errorf("the other Kimi companion receives memory-only values: %+v", published)
	}
	if env.ep.hits.Load() != 1 {
		t.Error("publication to another companion did not fetch")
	}

	before := env.ep.hits.Load()
	m.usageFor(usageRequest{BlockId: "b1"})
	m.usageFor(usageRequest{BlockId: "b1", Fetch: false})
	if env.ep.hits.Load() != before {
		t.Error("a hidden window causes no network read")
	}
	m.SetUsageExperimental("b1", false)
	if _, err := usage.DefaultKimiOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("off clears cached values: %v", err)
	}
}

func TestKimiSettingsChangesClearValues(t *testing.T) {
	m, _ := kimiUsageTestManager(t)
	m.SetUsageGauges("b1", true)
	m.SetUsageExperimental("b1", true)
	settingsChanged(&wconfig.SettingsType{CompanionUsageGauges: []string{"kimi"}})
	if _, err := usage.DefaultKimiOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("source opt-in removed: %v", err)
	}
	m.SetUsageExperimental("b1", true)
	settingsChanged(&wconfig.SettingsType{CompanionUsageKimiOAuth: true})
	if _, err := usage.DefaultKimiOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("agent gauges removed: %v", err)
	}
}
