// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
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
)

type ClaudeOAuthSource struct {
	oauthEngine
}

// DefaultClaudeOAuthSource is the one source Claude Code's adapter registers.
var DefaultClaudeOAuthSource = MakeClaudeOAuthSource()

func MakeClaudeOAuthSource() *ClaudeOAuthSource {
	s := &ClaudeOAuthSource{oauthEngine: oauthEngine{
		endpoint:    ClaudeUsageEndpoint,
		client:      makeOAuthClient(nil),
		credentials: readClaudeCredentials,
		store:       claudeCredentialStore,
		now:         time.Now,
	}}
	s.fetchFn = s.fetch
	return s
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

func (s *ClaudeOAuthSource) RefreshEvery() time.Duration { return oauthAutoInterval }

// ClaudeOAuthTestHooks replace what the source calls, for a test: a local https server, its client, fake
// credentials and a clock. Nil keeps the current one.
type ClaudeOAuthTestHooks = oauthTestHooks

// UseForTest swaps the source's dependencies and returns what restores them. It refuses to run outside `go test`:
// a production binary can only reach Anthropic's endpoint with Claude Code's own credentials.
func (s *ClaudeOAuthSource) UseForTest(hooks ClaudeOAuthTestHooks) func() {
	if !testing.Testing() {
		panic("ClaudeOAuthSource.UseForTest outside a test")
	}
	return s.override(hooks)
}
