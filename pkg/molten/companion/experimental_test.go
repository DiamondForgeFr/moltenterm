// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const companionFakeToken = "sk-ant-oat01-FAKE-companion-token-0123456789abcdefghijklmnop"

type fakeUsageEndpoint struct {
	hits   atomic.Int32
	lock   sync.Mutex
	status int
}

func (f *fakeUsageEndpoint) setStatus(status int) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.status = status
}

func (f *fakeUsageEndpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits.Add(1)
	f.lock.Lock()
	status := f.status
	f.lock.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+companionFakeToken {
		status = http.StatusUnauthorized
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	reset := time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	io.WriteString(w, `{"five_hour":{"utilization":21,"resets_at":"`+reset+`"},"seven_day":{"utilization":55,"resets_at":"`+reset+`"},`+
		`"seven_day_opus":{"utilization":9,"resets_at":"`+reset+`"},"extra_usage":{"is_enabled":true,"monthly_limit":2000,"used_credits":500,"currency":"USD"}}`)
}

type experimentalEnv struct {
	*gaugesEnv
	ep      *fakeUsageEndpoint
	written map[string]any
}

// experimentalTestManager points Claude Code's experimental source at a local https server with a fake token:
// the user's Keychain and credentials are never read.
func experimentalTestManager(t *testing.T) (*Manager, *experimentalEnv) {
	m, g, _ := gaugesTestManager(t)
	env := &experimentalEnv{gaugesEnv: g, ep: &fakeUsageEndpoint{status: 200}, written: map[string]any{}}
	srv := httptest.NewTLSServer(env.ep)
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	client := srv.Client()
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	t.Cleanup(usage.DefaultClaudeOAuthSource.UseForTest(usage.ClaudeOAuthTestHooks{
		Endpoint: srv.URL + "/api/oauth/usage",
		Client:   client,
		Credentials: func(ctx context.Context) (string, int64, error) {
			return companionFakeToken, 0, nil
		},
		Store: func() string { return "the test store" },
	}))
	m.writeSetting = func(key string, value any) error {
		g.lock.Lock()
		defer g.lock.Unlock()
		env.written[key] = value
		g.settings.CompanionUsageClaudeOAuth = value == true
		return nil
	}
	return m, env
}

func noCompanionToken(t *testing.T, what string, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	if strings.Contains(string(data), "FAKE-companion-token") {
		t.Errorf("%s carries the token: %s", what, data)
	}
}

func TestExperimentalSourceOptIn(t *testing.T) {
	m, env := experimentalTestManager(t)
	if _, err := m.Open("b3", "v"); err != nil {
		t.Fatal(err)
	}
	defer m.Close("b3", "v")
	if info, _ := m.Usage("b1", false); info.Experimental != nil {
		t.Errorf("not offered while the gauges are off: %+v", info.Experimental)
	}
	if _, err := m.SetUsageExperimental("b1", true); err == nil {
		t.Error("needs the gauges on")
	}
	if _, err := m.SetUsageExperimental("b2", true); err == nil {
		t.Error("Claude Code only")
	}
	if len(env.written) != 0 || env.ep.hits.Load() != 0 {
		t.Fatal("nothing written or called before the confirmation")
	}

	info, err := m.SetUsageGauges("b1", true)
	if err != nil || info.Experimental == nil || info.Experimental.On || info.Experimental.Store != "the test store" {
		t.Fatalf("offered off once the gauges are on: %+v %v", info.Experimental, err)
	}
	if info.Experimental.Name != "Anthropic usage endpoint" || info.RefreshMs != 0 || env.ep.hits.Load() != 0 {
		t.Errorf("off: %+v, no call", info)
	}

	info, err = m.SetUsageExperimental("b1", true)
	if err != nil || env.written["companion:usageclaudeoauth"] != true {
		t.Fatalf("on: %v %v", err, env.written)
	}
	if !info.Experimental.On || info.Experimental.Reason != "" || info.RefreshMs != (5*time.Minute).Milliseconds() {
		t.Errorf("on: %+v %d", info.Experimental, info.RefreshMs)
	}
	// No relay set up: the session and week come from the endpoint instead of the setup (FR-SHELL-028-AC3).
	if info.Gauges != usage.GaugesEnabled || info.Setup != nil || len(info.Snapshot.Windows) != 3 || info.Snapshot.Credits == nil {
		t.Fatalf("windows from the endpoint: %+v", info)
	}
	if info.Snapshot.Windows[2].Id != "model:opus" || info.Snapshot.Windows[2].Label != "This week (Opus)" {
		t.Errorf("model window: %+v", info.Snapshot.Windows[2])
	}
	if p := env.publishedFor("b3"); len(p) == 0 || !p[len(p)-1].Experimental.On {
		t.Errorf("the other Claude Code companion follows: %+v", p)
	}
	noCompanionToken(t, "usage info", info)
	for _, p := range env.publishedFor("b3") {
		noCompanionToken(t, "published event", p)
	}
	settingsJSON, _ := json.Marshal(env.get())
	if strings.Contains(string(settingsJSON), "FAKE-companion-token") || !strings.Contains(string(settingsJSON), `"companion:usageclaudeoauth":true`) {
		t.Errorf("settings keep only the opt-in: %s", settingsJSON)
	}

	// The status line's own report changes nothing on the network.
	before := env.ep.hits.Load()
	m.RecordStatusLine(statusLineReport("b1", 30))
	m.Usage("b1", false)
	if env.ep.hits.Load() != before {
		t.Error("no new call within 5 minutes, and none from a status line report")
	}
	info, _ = m.Usage("b1", false)
	if info.Snapshot.Windows[0].UsedPercent != 30 || info.SourceName != "Claude Code status line and Anthropic usage endpoint" {
		t.Errorf("the status line wins session and week: %+v %s", info.Snapshot.Windows, info.SourceName)
	}

	info, err = m.SetUsageExperimental("b1", false)
	if err != nil || env.written["companion:usageclaudeoauth"] != nil || info.Experimental.On || info.RefreshMs != 0 {
		t.Fatalf("off: %+v %v", info.Experimental, err)
	}
	if info.Snapshot.Credits != nil || len(info.Snapshot.Windows) != 2 {
		t.Errorf("off: only the status line's windows: %+v", info.Snapshot)
	}
	if _, err := usage.DefaultClaudeOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("turning it off forgets what it read: %v", err)
	}
}

func TestExperimentalSourceFailureKeepsTheStatusLine(t *testing.T) {
	m, env := experimentalTestManager(t)
	m.SetUsageGauges("b1", true)
	m.RecordStatusLine(statusLineReport("b1", 30))
	env.ep.setStatus(http.StatusTooManyRequests)
	info, err := m.SetUsageExperimental("b1", true)
	if err != nil || info.Gauges != usage.GaugesEnabled || len(info.Snapshot.Windows) != 2 {
		t.Fatalf("the status line stays: %+v %v", info, err)
	}
	if info.Experimental.Reason != usage.ReasonRateLimited {
		t.Errorf("the experimental source says why: %+v", info.Experimental)
	}
	env.ep.setStatus(200)
	m.Usage("b1", true)
	if env.ep.hits.Load() != 1 {
		t.Error("a refresh waits for the backoff")
	}
}

func TestSettingsChangeStopsTheExperimentalSource(t *testing.T) {
	m, _ := experimentalTestManager(t)
	m.SetUsageGauges("b1", true)
	m.SetUsageExperimental("b1", true)
	if _, err := usage.DefaultClaudeOAuthSource.Read(context.Background(), "b1"); err != nil {
		t.Fatalf("on: %v", err)
	}
	settingsChanged(&wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}})
	if _, err := usage.DefaultClaudeOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("a hand edit turning it off clears it: %v", err)
	}
	m.SetUsageExperimental("b1", true)
	settingsChanged(&wconfig.SettingsType{CompanionUsageClaudeOAuth: true})
	if _, err := usage.DefaultClaudeOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("turning the gauges off clears it too: %v", err)
	}
}

func TestHidingPlanUsageStopsTheExperimentalSourceUntilShownAgain(t *testing.T) {
	m, env := experimentalTestManager(t)
	m.SetUsageGauges("b1", true)
	m.SetUsageExperimental("b1", true)
	if env.ep.hits.Load() != 1 {
		t.Fatalf("on: %d calls", env.ep.hits.Load())
	}
	info, _ := m.SetUsageGauges("b1", false)
	if info.Experimental != nil || info.RefreshMs != 0 {
		t.Errorf("hidden: nothing offered or polled: %+v", info)
	}
	m.Usage("b1", true)
	if env.ep.hits.Load() != 1 {
		t.Error("no call while plan usage is hidden")
	}
	if _, err := usage.DefaultClaudeOAuthSource.Read(context.Background(), "b1"); usage.ReasonOf(err) != usage.ReasonWaiting {
		t.Errorf("hiding forgets what it read: %v", err)
	}
	// Shown again within the Refresh limit: the opt-in is kept, no call yet.
	info, _ = m.SetUsageGauges("b1", true)
	if env.ep.hits.Load() != 1 || info.Experimental == nil || !info.Experimental.On {
		t.Errorf("shown again: %+v, %d calls", info.Experimental, env.ep.hits.Load())
	}
}
