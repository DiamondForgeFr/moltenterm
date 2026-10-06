// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Undocumented sources (FR-SHELL-028): the user turns each on by itself, after a confirmation that says what it
// reads, on top of the agent's gauges. They may call the network, only for a companion that asks (NFR-SHELL-013).

const (
	// Why an experimental source gives nothing, in plain words in the companion.
	ReasonSignedOut    = "signedout"
	ReasonTokenExpired = "tokenexpired"
	ReasonDenied       = "denied"
	ReasonRateLimited  = "ratelimited"
	ReasonOffline      = "offline"
)

// OptInSource is a source with its own opt-in, kept in a setting of its own and written only from its confirmation.
type OptInSource interface {
	GaugesSource
	// OptedIn reads the source's own opt-in, whatever the agent's gauges.
	OptedIn(settings *wconfig.SettingsType) bool
	// SettingKey is the setting that keeps the opt-in.
	SettingKey() string
	// SetOptIn writes the opt-in into a copy of the settings, as the setting write would.
	SetOptIn(settings *wconfig.SettingsType, on bool)
	// Store names where the source reads the credentials it uses, for its confirmation; never anything read there.
	Store() string
}

// PolledSource is a source the companion asks again while it is visible, as often as RefreshEvery.
type PolledSource interface {
	RefreshEvery() time.Duration
}

type fetchKey struct{}

// WithFetch marks a read a visible companion asked for: only such a read may call the network (NFR-SHELL-013).
// A refresh may always.
func WithFetch(ctx context.Context, fetch bool) context.Context {
	return context.WithValue(ctx, fetchKey{}, fetch)
}

func CanFetch(ctx context.Context) bool {
	fetch, _ := ctx.Value(fetchKey{}).(bool)
	return fetch || IsRefresh(ctx)
}

// OptInOf returns the agent's source with its own opt-in, or nil.
func OptInOf(a UsageAdapter) OptInSource {
	if a == nil {
		return nil
	}
	for _, s := range a.Sources() {
		if o, ok := s.(OptInSource); ok {
			return o
		}
	}
	return nil
}

// RefreshEveryOf is how often a visible companion asks again for the sources turned on; 0 when none is polled.
func RefreshEveryOf(a UsageAdapter, settings *wconfig.SettingsType) time.Duration {
	var rtn time.Duration
	for _, s := range EnabledSources(a, settings) {
		p, ok := s.(PolledSource)
		if !ok {
			continue
		}
		if every := p.RefreshEvery(); every > 0 && (rtn == 0 || every < rtn) {
			rtn = every
		}
	}
	return rtn
}

// SyncSources follows the settings (NFR-SHELL-011): a source no longer turned on (the gauges or its own opt-in)
// forgets its values and stops its calls; one turned on may call again.
func SyncSources(a UsageAdapter, settings *wconfig.SettingsType) {
	if a == nil {
		return
	}
	for _, s := range a.Sources() {
		if s.Enabled(settings) {
			if r, ok := s.(interface{ Resume() }); ok {
				r.Resume()
			}
			continue
		}
		if c, ok := s.(interface{ Clear() }); ok {
			c.Clear()
		}
	}
}
