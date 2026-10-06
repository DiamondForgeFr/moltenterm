// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A fake token, never a real one: tests use no Keychain and no real credentials file.
const fakeToken = "sk-ant-oat01-FAKE-test-token-0123456789abcdefghijklmnopqrstuvwxyz"

const sampleUsage = `{
	"five_hour": {"utilization": 37.5, "resets_at": "2026-10-06T18:00:00.123456+00:00"},
	"seven_day": {"utilization": 62, "resets_at": "2026-10-09T09:00:00Z"},
	"seven_day_oauth_apps": {"utilization": 99, "resets_at": "2026-10-09T09:00:00Z"},
	"seven_day_opus": {"utilization": 12.25, "resets_at": "2026-10-09T09:00:00Z"},
	"seven_day_sonnet": {"utilization": null, "resets_at": null},
	"cinder_cove": {"utilization": 5, "resets_at": null},
	"limits": [
		{"kind": "weekly_scoped", "group": "g", "percent": 81, "resets_at": "2026-10-10T09:00:00Z", "severity": "warning", "is_active": true, "scope": {"model": {"display_name": "Fable"}}},
		{"kind": "weekly_scoped", "percent": 30, "resets_at": null, "scope": {"model": {"display_name": "Opus"}}},
		{"kind": "session", "percent": 10, "resets_at": null, "scope": {"model": {"display_name": "Haiku"}}},
		{"kind": "weekly_scoped", "percent": "high", "resets_at": null, "scope": {"model": {"display_name": "Bad"}}}
	],
	"extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "utilization": 25, "currency": "USD"},
	"something_new": {"x": 1}
}`

type fakeClock struct {
	lock sync.Mutex
	t    time.Time
}

func (c *fakeClock) now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.t = c.t.Add(d)
}

type fakeEndpoint struct {
	srv      *httptest.Server
	hits     atomic.Int32
	lock     sync.Mutex
	status   int
	body     string
	ctype    string
	header   map[string]string
	block    chan struct{}
	lastReq  *http.Request
	lastBody []byte
}

func (f *fakeEndpoint) set(status int, body string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.status, f.body = status, body
}

func (f *fakeEndpoint) request() (*http.Request, []byte) {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.lastReq, f.lastBody
}

func (f *fakeEndpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits.Add(1)
	body, _ := io.ReadAll(r.Body)
	f.lock.Lock()
	f.lastReq, f.lastBody = r.Clone(context.Background()), body
	status, resp, ctype, header, block := f.status, f.body, f.ctype, f.header, f.block
	f.lock.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-r.Context().Done():
			return
		}
	}
	for k, v := range header {
		w.Header().Set(k, v)
	}
	if ctype == "" {
		ctype = "application/json"
	}
	w.Header().Set("Content-Type", ctype)
	w.WriteHeader(status)
	io.WriteString(w, resp)
}

func tlsClientFor(srv *httptest.Server) *http.Client {
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return makeOAuthClient(&tls.Config{RootCAs: pool})
}

type oauthFixture struct {
	src      *ClaudeOAuthSource
	ep       *fakeEndpoint
	clock    *fakeClock
	creds    atomic.Int32
	token    string
	expires  int64
	credsErr error
	logs     *bytes.Buffer
}

// newOAuthFixture points a fresh source at a local https server, with fake credentials, and captures the log.
func newOAuthFixture(t *testing.T) *oauthFixture {
	t.Helper()
	f := &oauthFixture{ep: &fakeEndpoint{status: 200, body: sampleUsage}, clock: &fakeClock{t: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)}, token: fakeToken}
	f.ep.srv = httptest.NewTLSServer(f.ep)
	t.Cleanup(f.ep.srv.Close)
	f.src = MakeClaudeOAuthSource()
	f.src.UseForTest(ClaudeOAuthTestHooks{
		Endpoint: f.ep.srv.URL + "/api/oauth/usage",
		Client:   tlsClientFor(f.ep.srv),
		Credentials: func(ctx context.Context) (string, int64, error) {
			f.creds.Add(1)
			return f.token, f.expires, f.credsErr
		},
		Store: func() string { return "the test store" },
		Now:   f.clock.now,
	})
	f.logs = &bytes.Buffer{}
	prev := log.Writer()
	log.SetOutput(io.MultiWriter(f.logs, prev))
	t.Cleanup(func() {
		log.SetOutput(prev)
		if strings.Contains(f.logs.String(), fakeToken) || strings.Contains(f.logs.String(), "FAKE-test-token") {
			t.Error("the token reached the log")
		}
	})
	return f
}

func fetchCtx() context.Context {
	return WithFetch(context.Background(), true)
}

func refreshCtx() context.Context {
	return WithRefresh(context.Background(), true)
}

// noToken fails the test when the token shows in anything the source gives out.
func noToken(t *testing.T, what string, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	text := string(data) + fmt.Sprintf("%+v", v)
	if err, ok := v.(error); ok && err != nil {
		text += err.Error()
	}
	if strings.Contains(text, fakeToken) || strings.Contains(text, "FAKE-test-token") {
		t.Errorf("%s carries the token: %s", what, text)
	}
}

func windowById(snap UsageSnapshot, id string) *UsageWindow {
	for i := range snap.Windows {
		if snap.Windows[i].Id == id {
			return &snap.Windows[i]
		}
	}
	return nil
}

func TestClaudeOAuthRequestAndWindows(t *testing.T) {
	f := newOAuthFixture(t)
	snap, err := f.src.Read(fetchCtx(), "b1")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	noToken(t, "snapshot", snap)
	req, body := f.ep.request()
	if req.Method != http.MethodGet || req.URL.Path != "/api/oauth/usage" || len(body) != 0 || req.ContentLength > 0 {
		t.Errorf("a GET without a body: %s %s %q", req.Method, req.URL.Path, body)
	}
	if req.Header.Get("Authorization") != "Bearer "+fakeToken || req.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
		t.Errorf("headers: %v", req.Header)
	}
	if req.TLS == nil {
		t.Error("over TLS")
	}
	want := map[string]struct {
		label string
		pct   float64
	}{
		WindowSession: {"Current session", 37.5},
		WindowWeek:    {"This week", 62},
		"model:opus":  {"This week (Opus)", 12.25},
		"model:fable": {"This week (Fable)", 81},
	}
	if len(snap.Windows) != len(want) {
		t.Errorf("windows: %+v", snap.Windows)
	}
	for id, w := range want {
		got := windowById(snap, id)
		if got == nil || got.Label != w.label || got.UsedPercent != w.pct {
			t.Errorf("%s: %+v, want %+v", id, got, w)
		}
	}
	if w := windowById(snap, WindowSession); w == nil || w.ResetsAt != time.Date(2026, 10, 6, 18, 0, 0, 123456000, time.UTC).UnixMilli() || w.WindowMins != fiveHourMins {
		t.Errorf("session reset: %+v", w)
	}
	for _, id := range []string{"model:oauth_apps", "model:sonnet", "model:haiku", "model:bad", "model:cinder_cove"} {
		if windowById(snap, id) != nil {
			t.Errorf("%s is not a model window the response gives", id)
		}
	}
	if snap.Credits == nil || *snap.Credits != (UsageCredits{Enabled: true, Used: 12.5, Limit: 50, Unit: "USD"}) {
		t.Errorf("credits in major units: %+v", snap.Credits)
	}
	if snap.Source != ClaudeOAuthSourceId || snap.Agent != "claude" || snap.ReadAt != f.clock.now().UnixMilli() {
		t.Errorf("snapshot: %+v", snap)
	}
}

func TestClaudeOAuthCallsOnlyForAVisibleCompanion(t *testing.T) {
	f := newOAuthFixture(t)
	if _, err := f.src.Read(context.Background(), "b1"); ReasonOf(err) != ReasonWaiting {
		t.Errorf("a read no companion asked for serves memory only: %v", err)
	}
	if f.ep.hits.Load() != 0 || f.creds.Load() != 0 {
		t.Error("no call and no credentials read without a companion's request")
	}
	if _, err := f.src.Read(fetchCtx(), "b1"); err != nil {
		t.Fatal(err)
	}
	if snap, err := f.src.Read(context.Background(), "b2"); err != nil || len(snap.Windows) == 0 || f.ep.hits.Load() != 1 {
		t.Errorf("memory serves every terminal: %v %d", err, f.ep.hits.Load())
	}
}

func TestClaudeOAuthRefreshLimits(t *testing.T) {
	f := newOAuthFixture(t)
	f.src.Read(fetchCtx(), "b1")
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
	for i, st := range steps {
		f.clock.add(st.after)
		f.src.Read(st.ctx, "b1")
		if got := f.ep.hits.Load(); got != st.hits {
			t.Fatalf("step %d: %d calls, want %d", i, got, st.hits)
		}
	}
}

func TestClaudeOAuthRateLimitedBacksOff(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.set(429, `{"error":"rate_limited"}`)
	f.ep.header = map[string]string{"Retry-After": "600"}
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonRateLimited {
		t.Fatalf("429: %v", err)
	}
	f.clock.add(9 * time.Minute)
	f.src.Read(refreshCtx(), "b1")
	if f.ep.hits.Load() != 1 {
		t.Error("Retry-After holds even a manual refresh")
	}
	f.clock.add(time.Minute)
	f.ep.header = nil
	f.src.Read(refreshCtx(), "b1")
	if f.ep.hits.Load() != 2 {
		t.Fatal("asked again once Retry-After passed")
	}
	// Without Retry-After the wait doubles from 5 min up to 60 min.
	for i, wait := range []time.Duration{5, 10, 20, 40, 60, 60} {
		f.clock.add(wait*time.Minute - time.Second)
		f.src.Read(refreshCtx(), "b1")
		if got := f.ep.hits.Load(); got != int32(2+i) {
			t.Fatalf("backoff %d: called before %v", i, wait*time.Minute)
		}
		f.clock.add(time.Second)
		f.src.Read(refreshCtx(), "b1")
		if got := f.ep.hits.Load(); got != int32(3+i) {
			t.Fatalf("backoff %d: not called after %v", i, wait*time.Minute)
		}
	}
	f.ep.set(200, sampleUsage)
	f.clock.add(time.Hour)
	if _, err := f.src.Read(refreshCtx(), "b1"); err != nil {
		t.Fatalf("back after the backoff: %v", err)
	}
}

func TestClaudeOAuthFailuresHideItsWindows(t *testing.T) {
	big := `{"five_hour":{"utilization":1,"resets_at":null},"pad":"` + strings.Repeat("x", maxUsageResponseBytes) + `"}`
	cases := []struct {
		name   string
		status int
		body   string
		ctype  string
		reason string
	}{
		{"unauthorized", 401, `{}`, "", ReasonDenied},
		{"forbidden", 403, `{}`, "", ReasonDenied},
		{"server error", 500, `{}`, "", ReasonFailed},
		{"redirect", 302, ``, "", ReasonFailed},
		{"not json", 200, `<html></html>`, "text/html", ReasonFormat},
		{"oversized", 200, big, "", ReasonFormat},
		{"array", 200, `[1,2]`, "", ReasonFormat},
		{"truncated", 200, `{"five_hour":`, "", ReasonFormat},
		{"unknown shape", 200, `{"usage":{"percent":3}}`, "", ReasonFormat},
		{"all null", 200, `{"five_hour":null,"seven_day":{"utilization":null,"resets_at":null},"extra_usage":{"is_enabled":false}}`, "", ReasonNoPlan},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newOAuthFixture(t)
			f.ep.set(c.status, c.body)
			f.ep.ctype = c.ctype
			if c.status == 302 {
				f.ep.header = map[string]string{"Location": f.ep.srv.URL + "/elsewhere"}
			}
			snap, err := f.src.Read(fetchCtx(), "b1")
			if ReasonOf(err) != c.reason || len(snap.Windows) != 0 {
				t.Errorf("reason %q, want %q (%+v)", ReasonOf(err), c.reason, snap)
			}
			noToken(t, "error", err)
			if c.status == 302 && f.ep.hits.Load() != 1 {
				t.Error("a redirect is never followed")
			}
		})
	}
}

func TestClaudeOAuthFailureAfterSuccessHidesOldWindows(t *testing.T) {
	f := newOAuthFixture(t)
	f.src.Read(fetchCtx(), "b1")
	f.ep.set(401, `{}`)
	f.clock.add(oauthAutoInterval)
	if snap, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonDenied || len(snap.Windows) != 0 {
		t.Errorf("the old windows go with the failure: %+v %v", snap, err)
	}
}

func TestClaudeOAuthMistypedFieldDropsItsWindowOnly(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.set(200, `{"five_hour":{"utilization":"12","resets_at":null},"seven_day":{"utilization":40,"resets_at":1790000000},`+
		`"seven_day_opus":{"utilization":7,"resets_at":"next tuesday"},"seven_day_Bad-Key":{"utilization":1,"resets_at":null},`+
		`"extra_usage":{"is_enabled":true,"monthly_limit":"lots","used_credits":3}}`)
	snap, err := f.src.Read(fetchCtx(), "b1")
	if err != nil || len(snap.Windows) != 1 || snap.Windows[0].Id != "model:opus" || snap.Credits != nil {
		t.Errorf("only the well-formed window stays: %+v %v", snap, err)
	}
	if len(snap.Windows) == 1 && snap.Windows[0].ResetsAt != 0 {
		t.Errorf("a reset time in another format is not told, the window stays: %+v", snap.Windows[0])
	}
}

func TestModelWindowIdsMatchAcrossShapes(t *testing.T) {
	if modelWindowId(modelDisplayName("opus_4_1")) != modelWindowId("Opus 4.1") || modelWindowId("Fable") != "model:fable" {
		t.Errorf("%s / %s", modelWindowId(modelDisplayName("opus_4_1")), modelWindowId("Opus 4.1"))
	}
}

func TestClaudeOAuthTimeout(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.block = make(chan struct{})
	defer close(f.ep.block)
	f.src.client.Timeout = 200 * time.Millisecond
	start := time.Now()
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonOffline {
		t.Errorf("timeout: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Error("the timeout holds")
	}
}

func TestClaudeOAuthNoCallWithoutUsableCredentials(t *testing.T) {
	f := newOAuthFixture(t)
	f.expires = f.clock.now().Add(-time.Minute).UnixMilli()
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonTokenExpired {
		t.Errorf("expired: %v", err)
	}
	f.clock.add(oauthAutoInterval)
	f.expires, f.credsErr = 0, Unavailable(ReasonSignedOut)
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonSignedOut {
		t.Errorf("signed out: %v", err)
	}
	f.clock.add(oauthAutoInterval)
	f.token, f.credsErr = "", nil
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonSignedOut {
		t.Errorf("empty token: %v", err)
	}
	if f.ep.hits.Load() != 0 {
		t.Error("no call without a usable token")
	}
}

func TestClaudeOAuthEndpointGuard(t *testing.T) {
	f := newOAuthFixture(t)
	f.src.anyEndpoint = false
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonFailed || f.creds.Load() != 0 || f.ep.hits.Load() != 0 {
		t.Errorf("only Anthropic's endpoint gets the token: %v", err)
	}
	f.src.anyEndpoint = true
	f.src.endpoint = strings.Replace(f.ep.srv.URL, "https://", "http://", 1) + "/api/oauth/usage"
	if _, err := f.src.Read(fetchCtx(), "b1"); ReasonOf(err) != ReasonFailed || f.creds.Load() != 0 {
		t.Errorf("never over plain http: %v", err)
	}
	prod := MakeClaudeOAuthSource()
	if prod.endpoint != "https://api.anthropic.com/api/oauth/usage" || prod.anyEndpoint {
		t.Errorf("production endpoint: %s", prod.endpoint)
	}
	if _, err := prod.checkEndpoint(); err != nil {
		t.Errorf("production endpoint refused: %v", err)
	}
}

func TestClaudeOAuthOneCallAtATime(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.block = make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.src.Read(refreshCtx(), "b1")
			errs <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(f.ep.block)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("waiters get the call's result: %v", err)
		}
	}
	if f.ep.hits.Load() != 1 {
		t.Errorf("%d calls, want 1", f.ep.hits.Load())
	}
}

func TestClaudeOAuthClearStopsTheCall(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.block = make(chan struct{})
	defer close(f.ep.block)
	done := make(chan error, 1)
	go func() {
		_, err := f.src.Read(fetchCtx(), "b1")
		done <- err
	}()
	for f.ep.hits.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	f.src.Clear()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a cleared call gives nothing")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Clear stops the call at once")
	}
	if time.Since(start) > time.Second {
		t.Error("too slow")
	}
	if _, err := f.src.Read(context.Background(), "b1"); ReasonOf(err) != ReasonWaiting {
		t.Errorf("nothing kept after Clear: %v", err)
	}
}

func TestClaudeOAuthStoppedUntilResumed(t *testing.T) {
	f := newOAuthFixture(t)
	f.src.Read(fetchCtx(), "b1")
	f.src.Clear()
	f.clock.add(time.Hour)
	if _, err := f.src.Read(refreshCtx(), "b1"); ReasonOf(err) != ReasonWaiting || f.ep.hits.Load() != 1 {
		t.Errorf("turned off: no call, whatever settings a read was given: %v", err)
	}
	f.src.Resume()
	if _, err := f.src.Read(refreshCtx(), "b1"); err != nil || f.ep.hits.Load() != 2 {
		t.Errorf("turned on again: %v", err)
	}
}

func TestClaudeOAuthOffAndOnKeepsTheLimits(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.set(429, `{}`)
	f.ep.header = map[string]string{"Retry-After": "1800"}
	f.src.Read(fetchCtx(), "b1")
	f.src.Clear()
	f.src.Resume()
	f.clock.add(10 * time.Minute)
	f.src.Read(refreshCtx(), "b1")
	if f.ep.hits.Load() != 1 {
		t.Error("turning off and on never skips a 429's wait")
	}
	f.clock.add(20 * time.Minute)
	f.src.Read(refreshCtx(), "b1")
	f.src.Clear()
	f.src.Resume()
	f.src.Read(refreshCtx(), "b1")
	if f.ep.hits.Load() != 2 {
		t.Errorf("nor the Refresh limit: %d calls", f.ep.hits.Load())
	}
}

func TestClaudeOAuthReadWithoutFetchNeverWaits(t *testing.T) {
	f := newOAuthFixture(t)
	f.ep.block = make(chan struct{})
	defer close(f.ep.block)
	go f.src.Read(fetchCtx(), "b1")
	for f.ep.hits.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	if _, err := f.src.Read(context.Background(), "b1"); ReasonOf(err) != ReasonWaiting {
		t.Errorf("answers from memory: %v", err)
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Error("a status line report never waits for the endpoint")
	}
}

func TestClaudeOAuthEnabledNeedsBothOptIns(t *testing.T) {
	src := MakeClaudeOAuthSource()
	cases := []struct {
		settings *wconfig.SettingsType
		want     bool
	}{
		{nil, false},
		{&wconfig.SettingsType{}, false},
		{&wconfig.SettingsType{CompanionUsageClaudeOAuth: true}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"codex"}, CompanionUsageClaudeOAuth: true}, false},
		{&wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}, CompanionUsageClaudeOAuth: true}, true},
	}
	for i, c := range cases {
		if got := src.Enabled(c.settings); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
	if src.SettingKey() != "companion:usageclaudeoauth" || src.Documented() || src.RefreshEvery() != 5*time.Minute {
		t.Error("contract")
	}
}

func TestClaudeOAuthMergesAfterTheStatusLine(t *testing.T) {
	f := newOAuthFixture(t)
	store := MakeStatusLineStore()
	sl := MakeClaudeStatusLineSource(store, func(cwd string) molten.StatusLineSetup { return molten.StatusLineSetup{Configured: true} })
	a := &pageAdapter{id: "claude", sources: []GaugesSource{sl, f.src}}
	on := &wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}, CompanionUsageClaudeOAuth: true}
	now := f.clock.now().UnixMilli()
	ctx := fetchCtx()

	res := ReadGauges(ctx, a, on, "b1", now)
	if res.State != GaugesEnabled || windowById(*res.Snapshot, WindowSession).UsedPercent != 37.5 {
		t.Fatalf("without the relay, session and week come from the endpoint: %+v", res)
	}
	if res.SourceName != "Anthropic usage endpoint" || res.Failures[ClaudeStatusLineSourceId] != ReasonWaiting {
		t.Errorf("source and failures: %+v", res)
	}

	resets := f.clock.now().Add(time.Hour).Unix()
	store.Record(molten.AgentStatusLineRequest{BlockId: "b1", RateLimits: true,
		FiveHour: &molten.StatusLineWindow{UsedPercent: 40, ResetsAt: resets},
		SevenDay: &molten.StatusLineWindow{UsedPercent: 63, ResetsAt: resets}}, now)
	res = ReadGauges(ctx, a, on, "b1", now)
	snap := *res.Snapshot
	if windowById(snap, WindowSession).UsedPercent != 40 || windowById(snap, WindowWeek).UsedPercent != 63 {
		t.Errorf("the status line wins session and week: %+v", snap.Windows)
	}
	if windowById(snap, "model:opus") == nil || snap.Credits == nil || snap.Credits.Limit != 50 {
		t.Errorf("model windows and credits from the endpoint: %+v", snap)
	}
	if res.SourceName != "Claude Code status line and Anthropic usage endpoint" {
		t.Errorf("source name: %q", res.SourceName)
	}
	if only := res.Without(ClaudeStatusLineSourceId, now); only.State != GaugesEnabled || windowById(*only.Snapshot, WindowSession).UsedPercent != 37.5 {
		t.Errorf("without the status line: %+v", only)
	}
	later := now + (10 * time.Minute).Milliseconds()
	if res.PushedStale(now, (5*time.Minute).Milliseconds()) || !res.PushedStale(later, (5*time.Minute).Milliseconds()) {
		t.Error("only the status line's own age makes it stale, never the polled endpoint's")
	}
	if fresh := res.FreshFirst(later, (5 * time.Minute).Milliseconds()); windowById(*fresh.Snapshot, WindowSession).UsedPercent != 37.5 {
		t.Errorf("a quiet status line gives way to the endpoint for the same window: %+v", fresh.Snapshot.Windows)
	}

	f.src.Clear()
	f.src.Resume()
	f.clock.add(oauthAutoInterval)
	f.ep.set(401, `{}`)
	res = ReadGauges(ctx, a, on, "b1", now)
	if res.State != GaugesEnabled || len(res.Snapshot.Windows) != 2 || res.Snapshot.Credits != nil {
		t.Errorf("a failing endpoint only loses its own windows: %+v", res.Snapshot)
	}
	if res.Failures[ClaudeOAuthSourceId] != ReasonDenied {
		t.Errorf("its reason is kept: %+v", res.Failures)
	}
	noToken(t, "result", res)

	SyncSources(a, &wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}})
	if !store.Has("b1") {
		t.Error("turning the experimental source off keeps the status line's values")
	}
	if RefreshEveryOf(a, on) != 5*time.Minute || RefreshEveryOf(a, &wconfig.SettingsType{CompanionUsageGauges: []string{"claude"}}) != 0 {
		t.Error("polled only while the endpoint is on")
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"":                              0,
		"120":                           2 * time.Minute,
		"-3":                            0,
		"999999":                        oauthBackoffMax,
		"soon":                          0,
		"Tue, 06 Oct 2026 12:10:00 GMT": 10 * time.Minute,
	}
	for v, want := range cases {
		if got := retryAfter(v, now); got != want {
			t.Errorf("%q: %v, want %v", v, got, want)
		}
	}
}

func TestParseCredits(t *testing.T) {
	cases := map[string]*UsageCredits{
		`{"is_enabled":true,"monthly_limit":2000,"used_credits":null,"currency":"EUR"}`: {Enabled: true, Used: 0, Limit: 20, Unit: "EUR"},
		`{"is_enabled":true,"monthly_limit":3000,"used_credits":120,"currency":"JPY"}`:  {Enabled: true, Used: 120, Limit: 3000, Unit: "JPY"},
		`{"is_enabled":true,"monthly_limit":1000,"used_credits":10}`:                    {Enabled: true, Used: 0.1, Limit: 10, Unit: "USD"},
		`{"is_enabled":false,"monthly_limit":1000,"used_credits":10}`:                   nil,
		`{"is_enabled":true,"monthly_limit":null,"used_credits":10}`:                    nil,
		`{"is_enabled":true,"monthly_limit":1000,"used_credits":10,"currency":"$$"}`:    nil,
		`{"is_enabled":"yes","monthly_limit":1000}`:                                     nil,
	}
	for raw, want := range cases {
		got := parseCredits(json.RawMessage(raw))
		if (got == nil) != (want == nil) || got != nil && *got != *want {
			t.Errorf("%s: %+v, want %+v", raw, got, want)
		}
	}
}

func TestClaudeCredentialPlace(t *testing.T) {
	env := func(vars map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) {
			v, ok := vars[k]
			return v, ok
		}
	}
	hash := func(dir string) string {
		sum := sha256.Sum256([]byte(dir))
		return hex.EncodeToString(sum[:])[:8]
	}
	p := claudeCredentialPlaceOf(env(nil), "/home/u", "alice")
	if p.service != "Claude Code-credentials" || p.account != "alice" || p.file != "/home/u/.claude/.credentials.json" {
		t.Errorf("default: %+v", p)
	}
	if got := p.storeName(true); got != `the macOS Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json` {
		t.Errorf("store on macOS: %s", got)
	}
	if got := p.storeName(false); got != "~/.claude/.credentials.json" {
		t.Errorf("store elsewhere: %s", got)
	}
	p = claudeCredentialPlaceOf(env(map[string]string{"CLAUDE_CONFIG_DIR": "/work/cc"}), "/home/u", "bob smith")
	if p.service != "Claude Code-credentials-"+hash("/work/cc") || p.account != "claude-code-user" || p.file != "/work/cc/.credentials.json" {
		t.Errorf("config dir: %+v", p)
	}
	p = claudeCredentialPlaceOf(env(map[string]string{"CLAUDE_CONFIG_DIR": "/work/cc", "CLAUDE_SECURESTORAGE_CONFIG_DIR": ""}), "/home/u", "alice")
	if p.service != "Claude Code-credentials" || p.file != "/home/u/.claude/.credentials.json" {
		t.Errorf("empty secure storage dir is the default: %+v", p)
	}
	p = claudeCredentialPlaceOf(env(map[string]string{"CLAUDE_CONFIG_DIR": "/a", "CLAUDE_SECURESTORAGE_CONFIG_DIR": "/s"}), "/home/u", "alice")
	if p.service != "Claude Code-credentials-"+hash("/s") || p.file != "/s/.credentials.json" {
		t.Errorf("secure storage dir wins: %+v", p)
	}
}

func TestReadClaudeCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data string) string {
		path := filepath.Join(dir, name)
		os.WriteFile(path, []byte(data), 0600)
		return path
	}
	good := write("good.json", `{"claudeAiOauth":{"accessToken":"`+fakeToken+`","refreshToken":"sk-ant-ort01-FAKE-refresh","expiresAt":1790000000000,"scopes":["user:inference"]}}`)
	before, _ := os.ReadFile(good)
	info, _ := os.Stat(good)
	token, expires, err := readClaudeCredentialsFile(good)
	if err != nil || token != fakeToken || expires != 1790000000000 {
		t.Fatalf("good: %v %d", err, expires)
	}
	after, _ := os.ReadFile(good)
	info2, _ := os.Stat(good)
	if !bytes.Equal(before, after) || !info.ModTime().Equal(info2.ModTime()) {
		t.Error("the credentials file is never written")
	}
	link := filepath.Join(dir, "link.json")
	os.Symlink(good, link)
	cases := map[string]string{
		filepath.Join(dir, "missing.json"): ReasonSignedOut,
		link:                               ReasonSignedOut,
		dir:                                ReasonSignedOut,
		write("big.json", strings.Repeat(" ", maxCredentialsBytes+1)):                ReasonFormat,
		write("bad.json", `{"claudeAiOauth":`):                                       ReasonSignedOut,
		write("none.json", `{"other":{}}`):                                           ReasonSignedOut,
		write("inject.json", `{"claudeAiOauth":{"accessToken":"abc\r\nX-Evil: 1"}}`): ReasonSignedOut,
	}
	for path, reason := range cases {
		_, _, err := readClaudeCredentialsFile(path)
		if ReasonOf(err) != reason {
			t.Errorf("%s: %v, want %s", filepath.Base(path), err, reason)
		}
		noToken(t, "error", err)
	}
}

func TestOAuthTokenRedactedFromBugReports(t *testing.T) {
	text := molten.RedactBugText("request failed with " + fakeToken + " and Bearer " + fakeToken)
	if strings.Contains(text, "FAKE-test-token") {
		t.Errorf("bug report keeps the token: %s", text)
	}
}

func TestUnavailableErrorsCarryOnlyAReason(t *testing.T) {
	err := Unavailable(ReasonDenied)
	if err.Error() != "plan usage unavailable: denied" || !errors.As(err, new(*UnavailableError)) {
		t.Errorf("error: %v", err)
	}
}
