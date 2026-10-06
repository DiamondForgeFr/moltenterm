// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package usage holds the per-agent usage adapters (FR-SHELL-026 to 029, DS-SHELL-028): each coding agent with a
// companion declares its provider's usage page and, optionally, the sources the plan gauges read, best first. Another
// agent plugs in with one adapter.
package usage

import (
	"context"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	WindowSession = "session"
	WindowWeek    = "week"
	// A model-specific window is "model:<name>", a window known only by its length "window:<mins>".
	WindowModelPrefix  = "model:"
	WindowLengthPrefix = "window:"

	GaugesEnabled     = "enabled"
	GaugesOff         = "off"
	GaugesUnavailable = "unavailable"
)

// UsageAdapter is what MoltenTerm knows of one agent's plan usage.
type UsageAdapter interface {
	// Id is the companion's agent id ("claude", "codex").
	Id() string
	// PageURL is the provider's own usage page: https, on Domain, checked at registration.
	PageURL() string
	// PageName names the page for the action's tooltip ("Claude usage" gives "Open Claude usage").
	PageName() string
	// Domain is the provider's domain the page lives on (the page may sit on a subdomain of it).
	Domain() string
	// Sources are the gauges sources, best first; empty when the agent has no gauges.
	Sources() []GaugesSource
}

// GaugesSource reads one way of knowing an agent's plan usage (FR-SHELL-027 to 029).
type GaugesSource interface {
	Id() string
	// Documented tells a source the agent's vendor documents from one observed only.
	Documented() bool
	// Enabled reads the user's opt-in: no source reads anything before it (NFR-SHELL-011).
	Enabled(settings *wconfig.SettingsType) bool
	Read(ctx context.Context, blockId string) (UsageSnapshot, error)
}

type UsageSnapshot struct {
	Agent   string        `json:"agent"`
	Source  string        `json:"source"`
	Plan    string        `json:"plan,omitempty"`
	Windows []UsageWindow `json:"windows,omitempty"`
	Credits *UsageCredits `json:"credits,omitempty"`
	ReadAt  int64         `json:"readat"`
}

type UsageWindow struct {
	Id          string  `json:"id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedpercent"`
	// ResetsAt is in Unix milliseconds; 0 when the source does not tell.
	ResetsAt   int64 `json:"resetsat,omitempty"`
	WindowMins int64 `json:"windowmins,omitempty"`
}

type UsageCredits struct {
	Enabled bool    `json:"enabled"`
	Used    float64 `json:"used"`
	Limit   float64 `json:"limit"`
	Unit    string  `json:"unit,omitempty"`
}

// MergeSnapshots merges the snapshots of an agent's sources, given best source first: a window id a better source
// already gave is skipped, a window past its reset is dropped (its numbers no longer hold), and the credits and plan
// come from the first source that has them. The merged snapshot names the sources it took a window from.
func MergeSnapshots(agent string, snapshots []UsageSnapshot, nowMs int64) (UsageSnapshot, bool) {
	merged := UsageSnapshot{Agent: agent}
	seen := map[string]bool{}
	var sources []string
	for _, snap := range snapshots {
		used := false
		for _, w := range snap.Windows {
			if w.Id == "" || seen[w.Id] {
				continue
			}
			if w.ResetsAt > 0 && w.ResetsAt <= nowMs {
				continue
			}
			seen[w.Id] = true
			merged.Windows = append(merged.Windows, w)
			used = true
		}
		if merged.Credits == nil && snap.Credits != nil {
			merged.Credits = snap.Credits
			used = true
		}
		if merged.Plan == "" && snap.Plan != "" {
			merged.Plan = snap.Plan
		}
		if !used {
			continue
		}
		sources = append(sources, snap.Source)
		if snap.ReadAt > 0 && (merged.ReadAt == 0 || snap.ReadAt < merged.ReadAt) {
			merged.ReadAt = snap.ReadAt
		}
	}
	if len(merged.Windows) == 0 && merged.Credits == nil {
		return UsageSnapshot{}, false
	}
	merged.Source = strings.Join(sources, ",")
	return merged, true
}

// UsagePage is what the companion view carries of an agent's usage page: the frontend holds no URL of its own.
type UsagePage struct {
	PageURL  string `json:"pageurl"`
	PageName string `json:"pagename"`
}

// PageOf returns the usage page of an agent, or nil when the agent has no usage adapter.
func PageOf(agent string) *UsagePage {
	a := For(agent)
	if a == nil {
		return nil
	}
	return &UsagePage{PageURL: a.PageURL(), PageName: a.PageName()}
}

// ReadGauges reads the sources the user turned on, best first, and merges what they give. A failing source only
// loses its windows (NFR-SHELL-012): "off" when no source is on, "unavailable" when none gave anything.
func ReadGauges(ctx context.Context, a UsageAdapter, settings *wconfig.SettingsType, blockId string, nowMs int64) (string, *UsageSnapshot) {
	sources := EnabledSources(a, settings)
	if len(sources) == 0 {
		return GaugesOff, nil
	}
	var snapshots []UsageSnapshot
	for _, s := range sources {
		if ctx.Err() != nil {
			break
		}
		snap, err := s.Read(ctx, blockId)
		if err != nil {
			continue
		}
		if snap.Source == "" {
			snap.Source = s.Id()
		}
		snapshots = append(snapshots, snap)
	}
	merged, ok := MergeSnapshots(a.Id(), snapshots, nowMs)
	if !ok {
		return GaugesUnavailable, nil
	}
	return GaugesEnabled, &merged
}

// EnabledSources lists an adapter's sources the user turned on, best first.
func EnabledSources(a UsageAdapter, settings *wconfig.SettingsType) []GaugesSource {
	if a == nil || settings == nil {
		return nil
	}
	var rtn []GaugesSource
	for _, s := range a.Sources() {
		if s.Enabled(settings) {
			rtn = append(rtn, s)
		}
	}
	return rtn
}
