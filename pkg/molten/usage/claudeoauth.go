// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"crypto/tls"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Claude Code's experimental source (FR-SHELL-028, DS-SHELL-032): the undocumented usage endpoint Claude Code's own
// /usage screen reads, called with Claude Code's stored sign-in token, only once the user turned it on. It adds what
// the status line lacks: each model's weekly limit and the extra usage credits. The token is read at call time and
// lives in local variables for one request: never in a field, a log line, an error, a snapshot or an RPC payload.
// Watch anthropics/claude-code#45392 and its successors: a documented source replaces this one when it exists.

const (
	ClaudeOAuthSourceId = "claude-oauth"
	ClaudeUsageEndpoint = "https://api.anthropic.com/api/oauth/usage"

	claudeOAuthBeta = "oauth-2025-04-20"

	oauthRequestTimeout = 5 * time.Second
	// The credentials read and the request together; under the companion's own read timeout.
	oauthFetchTimeout     = 9 * time.Second
	maxUsageResponseBytes = 64 * 1024
	maxUsageHeaderBytes   = 32 * 1024

	// NFR-SHELL-013: automatic reads at most every 5 min, a manual Refresh at most every minute, both counted from
	// the last call; a 429 waits for Retry-After, else doubles from 5 min up to 60 min.
	oauthAutoInterval   = 5 * time.Minute
	oauthManualInterval = time.Minute
	oauthBackoffStart   = 5 * time.Minute
	oauthBackoffMax     = 60 * time.Minute
)

// credentialReader returns Claude Code's access token and its expiry in Unix ms (0 when not given). The token must
// stay in the caller's local variables.
type credentialReader func(ctx context.Context) (string, int64, error)

type oauthCall struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

// oauthOutcome is how a call ended: a reason when it gave nothing, and how long to wait after a 429.
type oauthOutcome struct {
	reason      string
	rateLimited bool
	retryAfter  time.Duration
}

// ClaudeOAuthSource keeps, in memory only, the last windows the endpoint gave and when it may be asked again.
// Stopped: turned off (Clear), it makes no call until it is turned on again (Resume), whatever settings a read was
// given meanwhile.
type ClaudeOAuthSource struct {
	lock         sync.Mutex
	generation   uint64
	stopped      bool
	snap         *UsageSnapshot
	reason       string
	lastCall     time.Time
	blockedUntil time.Time
	backoff      time.Duration
	call         *oauthCall

	// Injected; replaced only by tests and by the test-only build (claudeoauth_testoverride.go).
	endpoint    string
	anyEndpoint bool
	client      *http.Client
	credentials credentialReader
	store       func() string
	now         func() time.Time
}

// DefaultClaudeOAuthSource is the one source Claude Code's adapter registers.
var DefaultClaudeOAuthSource = MakeClaudeOAuthSource()

func MakeClaudeOAuthSource() *ClaudeOAuthSource {
	return &ClaudeOAuthSource{
		endpoint:    ClaudeUsageEndpoint,
		client:      makeOAuthClient(nil),
		credentials: readClaudeCredentials,
		store:       claudeCredentialStore,
		now:         time.Now,
	}
}

// makeOAuthClient verifies TLS (1.2 at least), follows no redirect and keeps no idle connection; roots nil uses the
// system's.
func makeOAuthClient(tlsConfig *tls.Config) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if tlsConfig == nil {
		tlsConfig = &tls.Config{}
	}
	tlsConfig.MinVersion = tls.VersionTLS12
	transport.TLSClientConfig = tlsConfig
	transport.DisableKeepAlives = true
	transport.MaxResponseHeaderBytes = maxUsageHeaderBytes
	transport.ResponseHeaderTimeout = oauthRequestTimeout
	return &http.Client{
		Transport: transport,
		Timeout:   oauthRequestTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (s *ClaudeOAuthSource) Id() string       { return ClaudeOAuthSourceId }
func (s *ClaudeOAuthSource) Name() string     { return "Anthropic usage endpoint" }
func (s *ClaudeOAuthSource) Documented() bool { return false }

func (s *ClaudeOAuthSource) Enabled(settings *wconfig.SettingsType) bool {
	return GaugesOn(settings, "claude") && s.OptedIn(settings)
}

func (s *ClaudeOAuthSource) OptedIn(settings *wconfig.SettingsType) bool {
	return settings != nil && settings.CompanionUsageClaudeOAuth
}

func (s *ClaudeOAuthSource) SettingKey() string { return wconfig.ConfigKey_CompanionUsageClaudeOAuth }

func (s *ClaudeOAuthSource) SetOptIn(settings *wconfig.SettingsType, on bool) {
	settings.CompanionUsageClaudeOAuth = on
}

func (s *ClaudeOAuthSource) Store() string {
	if s.store == nil {
		return ""
	}
	return s.store()
}

func (s *ClaudeOAuthSource) RefreshEvery() time.Duration { return oauthAutoInterval }

// Clear stops a call in progress at once, forgets everything the source read and makes no call until Resume. When
// it may call again (the last call, a 429's wait) is kept: turning the source off and on never skips them.
func (s *ClaudeOAuthSource) Clear() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.generation++
	s.stopped = true
	if s.call != nil {
		s.call.cancel()
		s.call = nil
	}
	s.snap, s.reason = nil, ""
}

// Resume lets the source call again once the user turned it on (or its gauges back on).
func (s *ClaudeOAuthSource) Resume() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.stopped = false
}

// Read gives the windows of the last call. A read a visible companion asked for calls the endpoint again when due,
// one call at a time, and waits for it; any other read (a status line report) answers from memory at once.
func (s *ClaudeOAuthSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	if !CanFetch(ctx) {
		return s.result()
	}
	call, gen, start := s.prepareCall(ctx)
	if start {
		go s.runCall(call, gen)
	}
	if call != nil {
		select {
		case <-call.done:
		case <-ctx.Done():
		}
	}
	return s.result()
}

func (s *ClaudeOAuthSource) prepareCall(ctx context.Context) (*oauthCall, uint64, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.stopped {
		return nil, s.generation, false
	}
	if s.call != nil {
		return s.call, s.generation, false
	}
	now := s.now()
	if now.Before(s.blockedUntil) {
		return nil, s.generation, false
	}
	interval := oauthAutoInterval
	if IsRefresh(ctx) {
		interval = oauthManualInterval
	}
	if !s.lastCall.IsZero() && now.Sub(s.lastCall) < interval {
		return nil, s.generation, false
	}
	callCtx, cancel := context.WithTimeout(context.Background(), oauthFetchTimeout)
	call := &oauthCall{ctx: callCtx, cancel: cancel, done: make(chan struct{})}
	s.call, s.lastCall = call, now
	return call, s.generation, true
}

func (s *ClaudeOAuthSource) runCall(call *oauthCall, gen uint64) {
	defer call.cancel()
	snap, outcome := s.fetch(call.ctx)
	s.finishCall(call, gen, snap, outcome)
}

// finishCall keeps what the call gave, unless the source was turned off (cleared) meanwhile.
func (s *ClaudeOAuthSource) finishCall(call *oauthCall, gen uint64, snap UsageSnapshot, outcome oauthOutcome) {
	s.lock.Lock()
	defer s.lock.Unlock()
	defer close(call.done)
	if s.call == call {
		s.call = nil
	}
	if gen != s.generation {
		return
	}
	if outcome.reason == "" {
		s.snap, s.reason, s.backoff, s.blockedUntil = &snap, "", 0, time.Time{}
		return
	}
	s.snap, s.reason = nil, outcome.reason
	if !outcome.rateLimited {
		return
	}
	wait := outcome.retryAfter
	if wait <= 0 {
		s.backoff = min(max(s.backoff*2, oauthBackoffStart), oauthBackoffMax)
		wait = s.backoff
	}
	wait = min(max(wait, oauthManualInterval), oauthBackoffMax)
	s.blockedUntil = s.now().Add(wait)
}

func (s *ClaudeOAuthSource) result() (UsageSnapshot, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.reason != "" {
		return UsageSnapshot{}, Unavailable(s.reason)
	}
	if s.snap == nil {
		return UsageSnapshot{}, Unavailable(ReasonWaiting)
	}
	return cloneSnapshot(*s.snap), nil
}

func cloneSnapshot(snap UsageSnapshot) UsageSnapshot {
	snap.Windows = append([]UsageWindow(nil), snap.Windows...)
	if snap.Credits != nil {
		credits := *snap.Credits
		snap.Credits = &credits
	}
	return snap
}

// ClaudeOAuthTestHooks replace what the source calls, for a test: a local https server, its client, fake
// credentials and a clock. Nil keeps the current one.
type ClaudeOAuthTestHooks struct {
	Endpoint    string
	Client      *http.Client
	Credentials func(ctx context.Context) (string, int64, error)
	Store       func() string
	Now         func() time.Time
}

// UseForTest swaps the source's dependencies and returns what restores them. It refuses to run outside `go test`:
// a production binary can only reach Anthropic's endpoint with Claude Code's own credentials.
func (s *ClaudeOAuthSource) UseForTest(hooks ClaudeOAuthTestHooks) func() {
	if !testing.Testing() {
		panic("ClaudeOAuthSource.UseForTest outside a test")
	}
	return s.override(hooks)
}

func (s *ClaudeOAuthSource) override(hooks ClaudeOAuthTestHooks) func() {
	s.lock.Lock()
	defer s.lock.Unlock()
	prev := *s.depsLocked()
	if hooks.Endpoint != "" {
		s.endpoint, s.anyEndpoint = hooks.Endpoint, true
	}
	if hooks.Client != nil {
		s.client = hooks.Client
	}
	if hooks.Credentials != nil {
		s.credentials = hooks.Credentials
	}
	if hooks.Store != nil {
		s.store = hooks.Store
	}
	if hooks.Now != nil {
		s.now = hooks.Now
	}
	return func() {
		s.Clear()
		s.lock.Lock()
		defer s.lock.Unlock()
		s.endpoint, s.anyEndpoint, s.client, s.credentials, s.store, s.now = prev.endpoint, prev.anyEndpoint, prev.client, prev.credentials, prev.store, prev.now
		s.stopped, s.lastCall, s.blockedUntil, s.backoff = false, time.Time{}, time.Time{}, 0
	}
}

type oauthDeps struct {
	endpoint    string
	anyEndpoint bool
	client      *http.Client
	credentials credentialReader
	store       func() string
	now         func() time.Time
}

func (s *ClaudeOAuthSource) depsLocked() *oauthDeps {
	return &oauthDeps{endpoint: s.endpoint, anyEndpoint: s.anyEndpoint, client: s.client, credentials: s.credentials, store: s.store, now: s.now}
}
