// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"crypto/tls"
	"net/http"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
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

// credentialReader returns an access token and its expiry in Unix ms (0 when not given). The token must stay in the
// caller's local variables.
type credentialReader func(ctx context.Context) (string, int64, error)

type oauthCall struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

// oauthOutcome is how a call ended: a reason when it gave nothing, and how long to wait after a 429. stale: the call
// gave an earlier reading back, and why it could not read a fresh one.
type oauthOutcome struct {
	reason      string
	rateLimited bool
	retryAfter  time.Duration
	stale       string
}

// oauthEngine keeps a source's snapshots and call state in memory only. Stopped means Clear was called: no call runs
// until Resume, whatever settings a read was given meanwhile.
type oauthEngine struct {
	lock         sync.Mutex
	generation   uint64
	stopped      bool
	snap         *UsageSnapshot
	reason       string
	invalidated  bool
	lastCall     time.Time
	blockedUntil time.Time
	backoff      time.Duration
	call         *oauthCall
	// credStamp is the credential file's metadata at the last look; credChanged lets the next call run without waiting
	// for the automatic interval (the agent refreshed its token, #2451).
	credStamp   string
	credChanged bool

	fetchFn     func(context.Context) (UsageSnapshot, oauthOutcome)
	endpoint    string
	anyEndpoint bool
	client      *http.Client
	credentials credentialReader
	store       func() string
	now         func() time.Time
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

// Clear stops a call in progress at once, forgets everything the source read and makes no call until Resume. When
// it may call again (the last call, a 429's wait) is kept: turning the source off and on never skips them.
func (e *oauthEngine) Clear() {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.generation++
	e.stopped = true
	if e.call != nil {
		e.call.cancel()
		e.call = nil
	}
	e.snap, e.reason, e.invalidated = nil, "", false
}

// Resume lets the source call again once the user turned it on (or its gauges back on).
func (e *oauthEngine) Resume() {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.stopped = false
}

// invalidate removes managed values after an eligibility failure without changing opt-in stopped state or throttles.
func (e *oauthEngine) invalidate(reason string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.generation++
	e.invalidated = true
	if e.call != nil {
		e.call.cancel()
		e.call = nil
	}
	e.snap, e.reason = nil, reason
}

// noteCredentials compares the credential file's metadata with the last look: a change means the agent wrote a new
// token, which the next call may read at once. An empty stamp (no file) changes nothing.
func (e *oauthEngine) noteCredentials(stamp string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	if stamp == "" {
		return
	}
	if e.credStamp != "" && stamp != e.credStamp {
		e.credChanged = true
	}
	e.credStamp = stamp
}

// isStale tells whether the reading in memory is an earlier one kept because no fresh one could be read.
func (e *oauthEngine) isStale() bool {
	e.lock.Lock()
	defer e.lock.Unlock()
	return e.snap != nil && e.snap.Stale != "" && e.reason == ""
}

func (e *oauthEngine) eligible() {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.invalidated {
		e.reason = ""
		e.invalidated = false
	}
}

// Read gives the windows of the last call. A read a visible companion asked for calls the endpoint again when due,
// one call at a time, and waits for it; any other read (a status line report) answers from memory at once.
func (e *oauthEngine) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	if !CanFetch(ctx) {
		return e.result()
	}
	call, gen, start := e.prepareCall(ctx)
	if start {
		go e.runCall(call, gen)
	}
	if call != nil {
		select {
		case <-call.done:
		case <-ctx.Done():
		}
	}
	return e.result()
}

func (e *oauthEngine) prepareCall(ctx context.Context) (*oauthCall, uint64, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.stopped {
		return nil, e.generation, false
	}
	if e.call != nil {
		return e.call, e.generation, false
	}
	now := e.now()
	if now.Before(e.blockedUntil) {
		return nil, e.generation, false
	}
	interval := oauthAutoInterval
	if IsRefresh(ctx) || e.credChanged {
		interval = oauthManualInterval
	}
	if !e.lastCall.IsZero() && now.Sub(e.lastCall) < interval {
		return nil, e.generation, false
	}
	e.credChanged = false
	callCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), oauthFetchTimeout)
	call := &oauthCall{ctx: callCtx, cancel: cancel, done: make(chan struct{})}
	e.call, e.lastCall = call, now
	return call, e.generation, true
}

func (e *oauthEngine) runCall(call *oauthCall, gen uint64) {
	fetched := false
	defer func() {
		err := panichandler.PanicHandler("molten:usage:oauth", recover())
		// A fetch that panicked still ends its call, else every read waits on it and no call starts again.
		if err != nil && !fetched {
			e.finishCall(call, gen, UsageSnapshot{}, oauthOutcome{reason: ReasonFailed})
		}
	}()
	defer call.cancel()
	snap, outcome := e.fetchFn(call.ctx)
	fetched = true
	e.finishCall(call, gen, snap, outcome)
}

// finishCall keeps what the call gave, unless the source was turned off (cleared) meanwhile.
func (e *oauthEngine) finishCall(call *oauthCall, gen uint64, snap UsageSnapshot, outcome oauthOutcome) {
	e.lock.Lock()
	defer e.lock.Unlock()
	defer close(call.done)
	if e.call == call {
		e.call = nil
	}
	if gen != e.generation {
		return
	}
	e.invalidated = false
	if outcome.reason == "" {
		snap.Stale = outcome.stale
		e.snap, e.reason = &snap, ""
		if outcome.stale == "" {
			e.backoff, e.blockedUntil = 0, time.Time{}
		}
		return
	}
	e.snap, e.reason = nil, outcome.reason
	if !outcome.rateLimited {
		return
	}
	wait := outcome.retryAfter
	if wait <= 0 {
		e.backoff = min(max(e.backoff*2, oauthBackoffStart), oauthBackoffMax)
		wait = e.backoff
	}
	wait = min(max(wait, oauthManualInterval), oauthBackoffMax)
	e.blockedUntil = e.now().Add(wait)
}

// lastGood is the reading in memory, nil when there is none.
func (e *oauthEngine) lastGood() *UsageSnapshot {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.snap == nil {
		return nil
	}
	snap := cloneSnapshot(*e.snap)
	return &snap
}

func (e *oauthEngine) result() (UsageSnapshot, error) {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.reason != "" {
		return UsageSnapshot{}, Unavailable(e.reason)
	}
	if e.snap == nil {
		return UsageSnapshot{}, Unavailable(ReasonWaiting)
	}
	return cloneSnapshot(*e.snap), nil
}

func cloneSnapshot(snap UsageSnapshot) UsageSnapshot {
	snap.Windows = append([]UsageWindow(nil), snap.Windows...)
	if snap.Credits != nil {
		credits := *snap.Credits
		if credits.Monthly != nil {
			monthly := *credits.Monthly
			credits.Monthly = &monthly
		}
		snap.Credits = &credits
	}
	return snap
}

type oauthDeps struct {
	endpoint    string
	anyEndpoint bool
	client      *http.Client
	credentials credentialReader
	store       func() string
	now         func() time.Time
}

func (e *oauthEngine) depsLocked() *oauthDeps {
	return &oauthDeps{endpoint: e.endpoint, anyEndpoint: e.anyEndpoint, client: e.client, credentials: e.credentials, store: e.store, now: e.now}
}

type oauthTestHooks struct {
	Endpoint    string
	Client      *http.Client
	Credentials func(ctx context.Context) (string, int64, error)
	Store       func() string
	Now         func() time.Time
}

func (e *oauthEngine) override(hooks oauthTestHooks) func() {
	e.lock.Lock()
	defer e.lock.Unlock()
	prev := *e.depsLocked()
	if hooks.Endpoint != "" {
		e.endpoint, e.anyEndpoint = hooks.Endpoint, true
	}
	if hooks.Client != nil {
		e.client = hooks.Client
	}
	if hooks.Credentials != nil {
		e.credentials = hooks.Credentials
	}
	if hooks.Store != nil {
		e.store = hooks.Store
	}
	if hooks.Now != nil {
		e.now = hooks.Now
	}
	return func() {
		e.Clear()
		e.lock.Lock()
		defer e.lock.Unlock()
		e.endpoint, e.anyEndpoint, e.client, e.credentials, e.store, e.now = prev.endpoint, prev.anyEndpoint, prev.client, prev.credentials, prev.store, prev.now
		e.stopped, e.lastCall, e.blockedUntil, e.backoff, e.invalidated = false, time.Time{}, time.Time{}, 0, false
	}
}

func (e *oauthEngine) Store() string {
	if e.store == nil {
		return ""
	}
	return e.store()
}
