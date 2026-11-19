// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	KimiOAuthSourceId = "kimi-oauth"
	KimiUsageEndpoint = "https://api.kimi.com/coding/v1/usages"
)

type KimiOAuthSource struct {
	oauthEngine
	managed func() error
}

var DefaultKimiOAuthSource = MakeKimiOAuthSource()

func MakeKimiOAuthSource() *KimiOAuthSource {
	s := &KimiOAuthSource{oauthEngine: oauthEngine{
		endpoint:    KimiUsageEndpoint,
		client:      makeOAuthClient(nil),
		credentials: readKimiCredentials,
		store:       kimiCredentialStore,
		now:         time.Now,
	}, managed: checkKimiManagedConfiguration}
	s.fetchFn = s.fetch
	return s
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

func (s *KimiOAuthSource) RefreshEvery() time.Duration { return oauthAutoInterval }

func (s *KimiOAuthSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	if _, err := s.checkEndpoint(); err != nil {
		s.invalidate(ReasonFailed)
		return s.result()
	}
	if err := s.managed(); err != nil {
		s.invalidate(ReasonOf(err))
		return s.result()
	}
	s.eligible()
	return s.oauthEngine.Read(ctx, blockId)
}

type KimiOAuthTestHooks struct {
	Endpoint    string
	Client      *http.Client
	Credentials func(ctx context.Context) (string, int64, error)
	Store       func() string
	Now         func() time.Time
	Managed     func() error
}

func (s *KimiOAuthSource) UseForTest(hooks KimiOAuthTestHooks) func() {
	if !testing.Testing() {
		panic("KimiOAuthSource.UseForTest outside a test")
	}
	restoreEngine := s.override(oauthTestHooks{
		Endpoint: hooks.Endpoint, Client: hooks.Client, Credentials: hooks.Credentials, Store: hooks.Store, Now: hooks.Now,
	})
	s.lock.Lock()
	previousManaged := s.managed
	if hooks.Managed != nil {
		s.managed = hooks.Managed
	} else if hooks.Credentials != nil {
		s.managed = func() error { return nil }
	}
	s.lock.Unlock()
	return func() {
		restoreEngine()
		s.lock.Lock()
		defer s.lock.Unlock()
		s.managed = previousManaged
	}
}
