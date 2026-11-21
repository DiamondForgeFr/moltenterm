// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	KimiOAuthSourceId   = "kimi-oauth"
	KimiUsageEndpoint   = "https://api.kimi.com/coding/v1/usages"
	KimiAIUsageEndpoint = "https://api.kimi.ai/coding/v1/usages"
)

type kimiConnectionContextKey struct{}

// While the reading shown is an earlier one (the token expired), a visible companion looks this often whether Kimi
// Code wrote a new token: a look compares the credential file's metadata and calls out only when it changed.
const kimiStaleRecheck = 30 * time.Second

type KimiOAuthSource struct {
	oauthEngine
	connection func() (kimiManagedConnection, error)
	// stamp gives the credential file's metadata, never its content; "" when there is no file.
	stamp   func(path string) string
	history *kimiHistory
}

func credentialFileStamp(path string) string {
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

var DefaultKimiOAuthSource = MakeKimiOAuthSource()

func MakeKimiOAuthSource() *KimiOAuthSource {
	s := &KimiOAuthSource{oauthEngine: oauthEngine{
		endpoint:    KimiUsageEndpoint,
		client:      makeOAuthClient(nil),
		credentials: readKimiCredentials,
		store:       kimiCredentialStore,
		now:         time.Now,
	}, connection: currentKimiManagedConnection, stamp: credentialFileStamp, history: &kimiHistory{path: defaultKimiHistoryPath}}
	s.fetchFn = s.fetchKeepingLast
	return s
}

// fetchKeepingLast records each reading, and gives the last one back, marked stale, while the token has expired:
// Kimi Code refreshes it only while it runs, and MoltenTerm never refreshes it itself (refresh tokens rotate, and a
// concurrent refresh could sign Kimi Code out).
func (s *KimiOAuthSource) fetchKeepingLast(ctx context.Context) (UsageSnapshot, oauthOutcome) {
	snap, outcome := s.fetch(ctx)
	if outcome.reason == "" {
		s.history.record(snap, s.now())
		return snap, outcome
	}
	if outcome.reason != ReasonTokenExpired {
		return snap, outcome
	}
	last := s.lastGood()
	if last == nil {
		last = s.history.last()
	}
	if last == nil {
		return snap, outcome
	}
	return *last, oauthOutcome{stale: ReasonTokenExpired}
}

// Clear forgets the readings too, the file included (NFR-SHELL-011).
func (s *KimiOAuthSource) Clear() {
	s.oauthEngine.Clear()
	s.history.clear()
}

func (s *KimiOAuthSource) Id() string       { return KimiOAuthSourceId }
func (s *KimiOAuthSource) Name() string     { return "Kimi Code managed usage endpoint" }
func (s *KimiOAuthSource) Documented() bool { return false }

func (s *KimiOAuthSource) Enabled(settings *wconfig.SettingsType) bool {
	return GaugesOn(settings, "kimi") && s.OptedIn(settings)
}

func (s *KimiOAuthSource) OptedIn(settings *wconfig.SettingsType) bool {
	return settings != nil && settings.CompanionUsageKimiOAuth
}

func (s *KimiOAuthSource) SettingKey() string { return wconfig.ConfigKey_CompanionUsageKimiOAuth }

func (s *KimiOAuthSource) SetOptIn(settings *wconfig.SettingsType, on bool) {
	settings.CompanionUsageKimiOAuth = on
}

func (s *KimiOAuthSource) RefreshEvery() time.Duration {
	if s.isStale() {
		return kimiStaleRecheck
	}
	return oauthAutoInterval
}

func (s *KimiOAuthSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	if _, err := s.checkEndpoint(); err != nil {
		s.invalidate(ReasonFailed)
		return s.result()
	}
	connection, err := s.connection()
	if err != nil {
		s.invalidate(ReasonOf(err))
		return s.result()
	}
	s.eligible()
	if CanFetch(ctx) {
		path := connection.credentialPath
		if path == "" {
			path = currentKimiCredentialPath()
		}
		s.noteCredentials(s.stamp(path))
	}
	ctx = context.WithValue(ctx, kimiConnectionContextKey{}, connection)
	snap, err := s.oauthEngine.Read(ctx, blockId)
	if err != nil {
		return snap, err
	}
	return s.history.withDeducedWeek(snap, s.now()), nil
}

type KimiOAuthTestHooks struct {
	Endpoint    string
	Client      *http.Client
	Credentials func(ctx context.Context) (string, int64, error)
	Store       func() string
	Now         func() time.Time
	Managed     func() error
	Connection  func() (kimiManagedConnection, error)
	// CredentialStamp stands for the credential file's metadata; History is where the readings are kept ("" keeps
	// none), Location the time zone of their days.
	CredentialStamp func() string
	History         string
	Location        *time.Location
}

func (s *KimiOAuthSource) UseForTest(hooks KimiOAuthTestHooks) func() {
	if !testing.Testing() {
		panic("KimiOAuthSource.UseForTest outside a test")
	}
	restoreEngine := s.override(oauthTestHooks{
		Endpoint: hooks.Endpoint, Client: hooks.Client, Credentials: hooks.Credentials, Store: hooks.Store, Now: hooks.Now,
	})
	s.lock.Lock()
	previousStamp, previousHistory := s.stamp, s.history
	if hooks.CredentialStamp != nil {
		s.stamp = func(string) string { return hooks.CredentialStamp() }
	}
	historyPath := hooks.History
	s.history = &kimiHistory{path: func() string { return historyPath }, loc: hooks.Location}
	previousConnection := s.connection
	if hooks.Connection != nil {
		s.connection = hooks.Connection
	} else if hooks.Managed != nil {
		s.connection = func() (kimiManagedConnection, error) { return kimiManagedConnection{}, hooks.Managed() }
	} else if hooks.Credentials != nil {
		s.connection = func() (kimiManagedConnection, error) { return kimiManagedConnection{}, nil }
	}
	s.lock.Unlock()
	return func() {
		restoreEngine()
		s.lock.Lock()
		defer s.lock.Unlock()
		s.connection = previousConnection
		s.stamp, s.history = previousStamp, previousHistory
	}
}
