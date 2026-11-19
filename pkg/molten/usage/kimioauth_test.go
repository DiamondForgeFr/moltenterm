// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const fakeKimiToken = "kimi-FAKE-managed-token-0123456789abcdefghijklmnopqrstuvwxyz"

const sampleKimiUsage = `{
	"usages": {
		"limit_5h": {"used_ratio": 0.375, "reset_time": "2026-11-19T18:00:00.123456789Z"},
		"limit_7d": {"used_ratio": "0.62", "reset_time": "2026-11-23T09:00:00Z"},
		"limit_month_total": {"used_ratio": 1.25, "reset_time": "2026-12-01T00:00:00+01:00"},
		"limit_month_code": {"used_ratio": 0.99, "reset_time": "2026-12-01T00:00:00Z"}
	},
	"boosterWallet": {
		"balance": {"type": "BOOSTER", "amount": 20000000000, "amountLeft": 1234500000},
		"monthlyChargeLimitEnabled": true,
		"monthlyChargeLimit": {"priceInCents": 2000, "currency": "USD"},
		"monthlyUsed": {"priceInCents": 543, "currency": "EUR"}
	}
}`

type kimiOAuthFixture struct {
	src         *KimiOAuthSource
	ep          *fakeEndpoint
	clock       *fakeClock
	creds       atomic.Int32
	managed     atomic.Int32
	managedLock sync.Mutex
	managedErr  error
	token       string
	expires     int64
	credsErr    error
	logs        *bytes.Buffer
}

func newKimiOAuthFixture(t *testing.T) *kimiOAuthFixture {
	t.Helper()
	f := &kimiOAuthFixture{ep: &fakeEndpoint{status: 200, body: sampleKimiUsage}, clock: &fakeClock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}, token: fakeKimiToken}
	f.ep.srv = httptest.NewTLSServer(f.ep)
	t.Cleanup(f.ep.srv.Close)
	f.src = MakeKimiOAuthSource()
	t.Cleanup(f.src.UseForTest(KimiOAuthTestHooks{
		Endpoint: f.ep.srv.URL + "/coding/v1/usages",
		Client:   tlsClientFor(f.ep.srv),
		Credentials: func(ctx context.Context) (string, int64, error) {
			f.creds.Add(1)
			return f.token, f.expires, f.credsErr
		},
		Store: func() string { return "~/.kimi-code/credentials/kimi-code.json" },
		Now:   f.clock.now,
		Managed: func() error {
			f.managed.Add(1)
			f.managedLock.Lock()
			defer f.managedLock.Unlock()
			return f.managedErr
		},
	}))
	f.logs = &bytes.Buffer{}
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(f.logs, previous))
	t.Cleanup(func() {
		log.SetOutput(previous)
		if strings.Contains(f.logs.String(), "FAKE-managed-token") {
			t.Error("the Kimi token reached the log")
		}
	})
	return f
}

func (f *kimiOAuthFixture) setManaged(err error) {
	f.managedLock.Lock()
	defer f.managedLock.Unlock()
	f.managedErr = err
}

func noKimiToken(t *testing.T, what string, value any) {
	t.Helper()
	data, _ := json.Marshal(value)
	text := string(data) + fmt.Sprintf("%+v", value)
	if err, ok := value.(error); ok && err != nil {
		text += err.Error()
	}
	if strings.Contains(text, "FAKE-managed-token") {
		t.Errorf("%s carries the token: %s", what, text)
	}
}

func waitKimiHits(t *testing.T, ep *fakeEndpoint, want int32) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for ep.hits.Load() < want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := ep.hits.Load(); got != want {
		t.Fatalf("endpoint hits %d, want %d", got, want)
	}
}

func TestKimiOAuthRequestWindowsAndCredits(t *testing.T) {
	f := newKimiOAuthFixture(t)
	snap, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	noKimiToken(t, "snapshot", snap)
	req, body := f.ep.request()
	if req.Method != http.MethodGet || req.URL.Path != "/coding/v1/usages" || len(body) != 0 || req.ContentLength > 0 {
		t.Errorf("bodyless GET: %s %s %q", req.Method, req.URL.Path, body)
	}
	if req.Header.Get("Authorization") != "Bearer "+fakeKimiToken || req.Header.Get("Accept") != "application/json" || req.Header.Get("anthropic-beta") != "" {
		t.Errorf("headers: %v", req.Header)
	}
	if req.TLS == nil {
		t.Error("request is over TLS")
	}
	if len(snap.Windows) != 3 {
		t.Fatalf("three windows, no limit_month_code gauge: %+v", snap.Windows)
	}
	session := windowById(snap, WindowSession)
	week := windowById(snap, WindowWeek)
	month := windowById(snap, WindowMonth)
	if session == nil || session.Label != "Current session" || session.UsedPercent != 37.5 || session.WindowMins != 300 {
		t.Errorf("session: %+v", session)
	}
	if session.ResetsAt != time.Date(2026, 11, 19, 18, 0, 0, 123456789, time.UTC).UnixMilli() {
		t.Errorf("session reset: %d", session.ResetsAt)
	}
	if week == nil || week.Label != "This week" || week.UsedPercent != 62 || week.WindowMins != 10080 {
		t.Errorf("week: %+v", week)
	}
	if month == nil || month.Label != "This month" || month.UsedPercent != 100 || month.WindowMins != 0 {
		t.Errorf("calendar month, clamped ratio: %+v", month)
	}
	wantMonthReset := time.Date(2026, 11, 30, 23, 0, 0, 0, time.UTC).UnixMilli()
	if month.ResetsAt != wantMonthReset {
		t.Errorf("month reset %d, want %d", month.ResetsAt, wantMonthReset)
	}
	if snap.Credits == nil || snap.Credits.Balance != "12.35" || snap.Credits.Unit != "USD" || snap.Credits.Used != 0 || snap.Credits.Limit != 0 {
		t.Fatalf("booster balance: %+v", snap.Credits)
	}
	monthly := snap.Credits.Monthly
	if monthly == nil || monthly.Used != 5.43 || monthly.Limit != 20 || !monthly.LimitEnabled || monthly.Unit != "USD" {
		t.Errorf("monthly spending beside the balance: %+v", monthly)
	}
	if snap.Agent != "kimi" || snap.Source != KimiOAuthSourceId || snap.ReadAt != f.clock.now().UnixMilli() {
		t.Errorf("snapshot identity: %+v", snap)
	}
}

func TestKimiWindowsKeepValidEntriesAndIgnoreBadResets(t *testing.T) {
	body := []byte(`{"usages":{
		"limit_5h":{"used_ratio":"not-a-number","reset_time":"2026-11-19T18:00:00Z"},
		"limit_7d":{"used_ratio":-2,"reset_time":1790000000},
		"limit_month_total":{"used_ratio":"0.255","reset_time":"not-a-time"},
		"limit_month_code":{"used_ratio":0.75,"reset_time":"2026-12-01T00:00:00Z"}
	}}`)
	snap, reason := parseKimiUsage(body)
	if reason != "" || len(snap.Windows) != 2 {
		t.Fatalf("valid windows survive malformed siblings: %+v %q", snap, reason)
	}
	if week := windowById(snap, WindowWeek); week == nil || week.UsedPercent != 0 || week.ResetsAt != 0 {
		t.Errorf("clamped week with unknown reset: %+v", week)
	}
	if month := windowById(snap, WindowMonth); month == nil || month.UsedPercent != 25.5 || month.ResetsAt != 0 || month.WindowMins != 0 {
		t.Errorf("month with unknown reset: %+v", month)
	}
	if windowById(snap, WindowSession) != nil || windowById(snap, "month_code") != nil {
		t.Errorf("malformed and ignored windows: %+v", snap.Windows)
	}
}

func TestKimiBoosterWalletMapping(t *testing.T) {
	cases := []struct {
		name         string
		wallet       string
		balance      string
		used         float64
		limit        float64
		limitEnabled bool
		unit         string
	}{
		{"positive sub-cent and default currency", `{"balance":{"type":"BOOSTER","amount":"1","amountLeft":1}}`, "0.01", 0, 0, false, "USD"},
		{"zero values stay present", `{"balance":{"type":"BOOSTER","amount":1000000,"amountLeft":0},"monthlyUsed":{"priceInCents":0,"currency":"EUR"},"monthlyChargeLimitEnabled":false}`, "0.00", 0, 0, false, "EUR"},
		{"used currency fallback and unlimited", `{"balance":{"type":"BOOSTER","amount":1000000,"amountLeft":2500000},"monthlyUsed":{"priceInCents":"125","currency":"CNY"},"monthlyChargeLimit":{"priceInCents":0,"currency":"USD"},"monthlyChargeLimitEnabled":true}`, "0.03", 1.25, 0, true, "USD"},
		{"invalid amount left is zero", `{"balance":{"type":"BOOSTER","amount":1000000,"amountLeft":"bad"},"monthlyUsed":{"priceInCents":25,"currency":"EUR"}}`, "0.00", 0.25, 0, false, "EUR"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap, reason := parseKimiUsage([]byte(`{"boosterWallet":` + tc.wallet + `}`))
			if reason != "" || snap.Credits == nil || snap.Credits.Monthly == nil {
				t.Fatalf("wallet: %+v %q", snap, reason)
			}
			monthly := snap.Credits.Monthly
			if snap.Credits.Balance != tc.balance || snap.Credits.Unit != tc.unit || monthly.Used != tc.used || monthly.Limit != tc.limit || monthly.LimitEnabled != tc.limitEnabled || monthly.Unit != tc.unit {
				t.Errorf("credits %+v, monthly %+v", snap.Credits, monthly)
			}
		})
	}
}

func TestKimiKnownEmptyUnknownAndInvalidShapes(t *testing.T) {
	cases := []struct {
		body   string
		reason string
	}{
		{`{}`, ReasonFormat},
		{`{"unknown":{}}`, ReasonFormat},
		{`[1,2]`, ReasonFormat},
		{`{"usages":{}}`, ReasonNoPlan},
		{`{"usages":null}`, ReasonNoPlan},
		{`{"boosterWallet":null}`, ReasonNoPlan},
		{`{"usages":{"limit_month_code":{"used_ratio":0.5}}}`, ReasonNoPlan},
		{`{"boosterWallet":{"balance":{"type":"BOOSTER","amount":0}}}`, ReasonNoPlan},
		{`{"boosterWallet":{"balance":{"type":"CASH","amount":1000000}}}`, ReasonNoPlan},
		{`{"boosterWallet":{"balance":{"type":"BOOSTER","amount":"bad"}}}`, ReasonNoPlan},
	}
	for _, tc := range cases {
		if snap, reason := parseKimiUsage([]byte(tc.body)); reason != tc.reason || len(snap.Windows) != 0 || snap.Credits != nil {
			t.Errorf("%s: %+v %q, want %q", tc.body, snap, reason, tc.reason)
		}
	}
}

func TestKimiOAuthFailuresAndCacheRemoval(t *testing.T) {
	big := `{"usages":{},"pad":"` + strings.Repeat("x", maxUsageResponseBytes) + `"}`
	cases := []struct {
		name   string
		status int
		body   string
		ctype  string
		reason string
	}{
		{"unauthorized", 401, `{}`, "", ReasonDenied},
		{"forbidden", 403, `{}`, "", ReasonDenied},
		{"payment required", 402, `{}`, "", ReasonFailed},
		{"not found", 404, `{}`, "", ReasonFailed},
		{"server error", 500, `{}`, "", ReasonFailed},
		{"redirect", 302, ``, "", ReasonFailed},
		{"content type", 200, `<html/>`, "text/html", ReasonFormat},
		{"oversize", 200, big, "", ReasonFormat},
		{"unknown", 200, `{"usage":{}}`, "", ReasonFormat},
		{"known empty", 200, `{"usages":{}}`, "", ReasonNoPlan},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newKimiOAuthFixture(t)
			f.ep.set(tc.status, tc.body)
			f.ep.ctype = tc.ctype
			if tc.status == 302 {
				f.ep.header = map[string]string{"Location": f.ep.srv.URL + "/elsewhere"}
			}
			snap, err := f.src.Read(fetchCtx(), "k1")
			if ReasonOf(err) != tc.reason || len(snap.Windows) != 0 || snap.Credits != nil {
				t.Errorf("%+v %v, want %s", snap, err, tc.reason)
			}
			noKimiToken(t, "error", err)
			if tc.status == 302 && f.ep.hits.Load() != 1 {
				t.Error("redirects are not followed")
			}
		})
	}

	f := newKimiOAuthFixture(t)
	if _, err := f.src.Read(fetchCtx(), "k1"); err != nil {
		t.Fatal(err)
	}
	f.ep.set(401, `{}`)
	f.clock.add(oauthAutoInterval)
	if snap, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonDenied || len(snap.Windows) != 0 || snap.Credits != nil {
		t.Errorf("a failed refresh removes old values: %+v %v", snap, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestKimiOAuthOfflineAndRateLimit(t *testing.T) {
	f := newKimiOAuthFixture(t)
	f.src.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("sanitized offline fixture")
	})}
	if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonOffline {
		t.Errorf("offline: %v", err)
	}

	f = newKimiOAuthFixture(t)
	f.ep.set(429, `{}`)
	f.ep.header = map[string]string{"Retry-After": "600"}
	if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonRateLimited {
		t.Fatalf("rate limited: %v", err)
	}
	f.clock.add(9 * time.Minute)
	f.src.Read(refreshCtx(), "k1")
	if f.ep.hits.Load() != 1 {
		t.Error("Retry-After holds a manual refresh")
	}
	f.clock.add(time.Minute)
	f.src.Read(refreshCtx(), "k1")
	if f.ep.hits.Load() != 2 {
		t.Error("request resumes after Retry-After")
	}
}

func TestKimiOAuthOptInsVisibilityAndExpiredToken(t *testing.T) {
	src := MakeKimiOAuthSource()
	cases := []struct {
		settings *wconfig.SettingsType
		want     bool
	}{
		{nil, false},
		{&wconfig.SettingsType{}, false},
		{&wconfig.SettingsType{CompanionUsageKimiOAuth: true}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"kimi"}}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}, CompanionUsageKimiOAuth: true}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"kimi"}, CompanionUsageKimiOAuth: true}, true},
	}
	for i, tc := range cases {
		if got := src.Enabled(tc.settings); got != tc.want {
			t.Errorf("case %d: %v, want %v", i, got, tc.want)
		}
	}
	if src.SettingKey() != "companion:usagekimioauth" || src.Documented() || src.RefreshEvery() != 5*time.Minute {
		t.Error("source contract")
	}

	f := newKimiOAuthFixture(t)
	managedBefore := f.managed.Load()
	if _, err := f.src.Read(context.Background(), "k1"); ReasonOf(err) != ReasonWaiting {
		t.Errorf("memory only: %v", err)
	}
	if f.ep.hits.Load() != 0 || f.creds.Load() != 0 || f.managed.Load() != managedBefore+1 {
		t.Error("no credential or network read without a visible companion")
	}
	f.expires = f.clock.now().Add(-time.Second).UnixMilli()
	if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonTokenExpired || f.ep.hits.Load() != 0 {
		t.Errorf("expired token is never refreshed or sent: %v", err)
	}
}

func TestKimiOAuthEndpointGuardPrecedesManagedAndCredentials(t *testing.T) {
	f := newKimiOAuthFixture(t)
	endpoints := []string{
		"https://api.kimi.ai/coding/v1/usages",
		"https://example.com/coding/v1/usages",
		"http://127.0.0.1/coding/v1/usages",
		"https://user@127.0.0.1/coding/v1/usages",
	}
	for _, endpoint := range endpoints {
		f.src.endpoint = endpoint
		f.src.anyEndpoint = true
		managedBefore, credsBefore, hitsBefore := f.managed.Load(), f.creds.Load(), f.ep.hits.Load()
		if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonFailed {
			t.Errorf("%s: %v", endpoint, err)
		}
		if f.managed.Load() != managedBefore || f.creds.Load() != credsBefore || f.ep.hits.Load() != hitsBefore {
			t.Errorf("%s was not refused before config, credentials and network", endpoint)
		}
	}
	prod := MakeKimiOAuthSource()
	if prod.endpoint != KimiUsageEndpoint || prod.anyEndpoint {
		t.Errorf("production endpoint: %s, any=%v", prod.endpoint, prod.anyEndpoint)
	}
	if _, err := prod.checkEndpoint(); err != nil {
		t.Errorf("pinned production endpoint: %v", err)
	}
}

func TestKimiOAuthThrottlesSingleFlightAndCancellation(t *testing.T) {
	f := newKimiOAuthFixture(t)
	f.src.Read(fetchCtx(), "k1")
	steps := []struct {
		after time.Duration
		ctx   context.Context
		hits  int32
	}{
		{30 * time.Second, fetchCtx(), 1},
		{10 * time.Second, refreshCtx(), 1},
		{21 * time.Second, refreshCtx(), 2},
		{4 * time.Minute, fetchCtx(), 2},
		{time.Minute, fetchCtx(), 3},
	}
	for i, step := range steps {
		f.clock.add(step.after)
		f.src.Read(step.ctx, "k1")
		if got := f.ep.hits.Load(); got != step.hits {
			t.Fatalf("step %d: %d calls, want %d", i, got, step.hits)
		}
	}

	f = newKimiOAuthFixture(t)
	f.ep.block = make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.src.Read(refreshCtx(), "k1")
			if err != nil {
				t.Errorf("shared call: %v", err)
			}
		}()
	}
	waitKimiHits(t, f.ep, 1)
	close(f.ep.block)
	wg.Wait()
	if f.ep.hits.Load() != 1 {
		t.Errorf("one in-flight call: %d", f.ep.hits.Load())
	}

	f = newKimiOAuthFixture(t)
	f.ep.block = make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := f.src.Read(fetchCtx(), "k1")
		done <- err
	}()
	waitKimiHits(t, f.ep, 1)
	f.src.Clear()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a cancelled call gives no snapshot")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Clear did not cancel the call")
	}
	close(f.ep.block)
}

func TestKimiOAuthOffOnPreservesThrottle(t *testing.T) {
	f := newKimiOAuthFixture(t)
	f.ep.set(429, `{}`)
	f.ep.header = map[string]string{"Retry-After": "1800"}
	f.src.Read(fetchCtx(), "k1")
	f.src.Clear()
	f.src.Resume()
	f.clock.add(10 * time.Minute)
	f.src.Read(refreshCtx(), "k1")
	if f.ep.hits.Load() != 1 {
		t.Error("off/on does not skip rate-limit backoff")
	}
	f.clock.add(20 * time.Minute)
	f.src.Read(refreshCtx(), "k1")
	f.src.Clear()
	f.src.Resume()
	f.src.Read(refreshCtx(), "k1")
	if f.ep.hits.Load() != 2 {
		t.Errorf("off/on does not skip the manual throttle: %d", f.ep.hits.Load())
	}
}
