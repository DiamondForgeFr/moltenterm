// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package usage holds the per-agent usage adapters (FR-SHELL-026 to 029, DS-SHELL-028): each coding agent with a
// companion declares its provider's usage page and, optionally, the sources the plan gauges read, best first. Another
// agent plugs in with one adapter.
package usage

import (
	"context"
	"errors"
	"slices"
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

	// Why the gauges are unavailable, in plain words in the companion (DS-SHELL-030).
	ReasonNotSetUp = "notsetup"
	ReasonWaiting  = "waiting"
	ReasonNoPlan   = "noplan"
	ReasonFormat   = "format"
	ReasonExpired  = "expired"
	ReasonFailed   = "failed"
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
	// Name names the source in the gauges' header ("Claude Code status line").
	Name() string
	// Documented tells a source the agent's vendor documents from one observed only.
	Documented() bool
	// Enabled reads the user's opt-in: no source reads anything before it (NFR-SHELL-011).
	Enabled(settings *wconfig.SettingsType) bool
	Read(ctx context.Context, blockId string) (UsageSnapshot, error)
}

// SetupSource is a source the user sets up outside MoltenTerm (Claude Code's status line): Setup tells, read-only,
// whether it is set up for a terminal whose folder is cwd, and returns what to paste when it is not.
type SetupSource interface {
	Setup(cwd string) *UsageSetup
}

// UsageSetup is what the companion shows to set a source up. MoltenTerm never applies it.
type UsageSetup struct {
	Source   string `json:"source"`
	File     string `json:"file"`
	Current  string `json:"current,omitempty"`
	Language string `json:"language"`
	Snippet  string `json:"snippet"`
}

// UnavailableError is a source failing for a reason the companion names.
type UnavailableError struct {
	Reason string
}

func (e *UnavailableError) Error() string {
	return "plan usage unavailable: " + e.Reason
}

func Unavailable(reason string) error {
	return &UnavailableError{Reason: reason}
}

// ReasonOf names a source's failure; any other error is a plain failure, its text never shown.
func ReasonOf(err error) string {
	var ue *UnavailableError
	if errors.As(err, &ue) && ue.Reason != "" {
		return ue.Reason
	}
	return ReasonFailed
}

type refreshKey struct{}

// WithRefresh marks a read the user asked for (the Refresh button): a network or process source (#262, #263) may
// then read again within its own limits (NFR-SHELL-013).
func WithRefresh(ctx context.Context, refresh bool) context.Context {
	return context.WithValue(ctx, refreshKey{}, refresh)
}

func IsRefresh(ctx context.Context) bool {
	refresh, _ := ctx.Value(refreshKey{}).(bool)
	return refresh
}

// GaugesOn reads the user's per-agent opt-in, `companion:usagegauges`.
func GaugesOn(settings *wconfig.SettingsType, agent string) bool {
	return settings != nil && agent != "" && slices.Contains(settings.CompanionUsageGauges, agent)
}

// WithGauges returns the opt-in list with the agent added or removed, without duplicates, in a new slice.
func WithGauges(list []string, agent string, on bool) []string {
	rtn := make([]string, 0, len(list)+1)
	for _, a := range list {
		if a != agent && a != "" && !slices.Contains(rtn, a) {
			rtn = append(rtn, a)
		}
	}
	if on {
		rtn = append(rtn, agent)
	}
	return rtn
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

// GaugesResult is what the gauges show: State, the merged snapshot when enabled, and Reason when unavailable.
// SourceName names the sources the windows came from, else the best source turned on.
type GaugesResult struct {
	State      string
	Snapshot   *UsageSnapshot
	Reason     string
	SourceName string
}

// ReadGauges reads the sources the user turned on, best first, and merges what they give. A failing source only
// loses its windows (NFR-SHELL-012): "off" when no source is on, "unavailable" when none gave anything, with the
// reason of the best source.
func ReadGauges(ctx context.Context, a UsageAdapter, settings *wconfig.SettingsType, blockId string, nowMs int64) GaugesResult {
	sources := EnabledSources(a, settings)
	if len(sources) == 0 {
		return GaugesResult{State: GaugesOff}
	}
	rtn := GaugesResult{State: GaugesUnavailable, SourceName: sources[0].Name()}
	var snapshots []UsageSnapshot
	names := map[string]string{}
	for _, s := range sources {
		if ctx.Err() != nil {
			break
		}
		snap, err := s.Read(ctx, blockId)
		if err != nil {
			if rtn.Reason == "" {
				rtn.Reason = ReasonOf(err)
			}
			continue
		}
		if snap.Source == "" {
			snap.Source = s.Id()
		}
		names[snap.Source] = s.Name()
		snapshots = append(snapshots, snap)
	}
	merged, ok := MergeSnapshots(a.Id(), snapshots, nowMs)
	if !ok {
		if rtn.Reason == "" {
			rtn.Reason = ReasonExpired
			if len(snapshots) == 0 {
				rtn.Reason = ReasonFailed
			}
		}
		return rtn
	}
	var used []string
	for _, id := range strings.Split(merged.Source, ",") {
		if n := names[id]; n != "" {
			used = append(used, n)
		}
	}
	if len(used) > 0 {
		rtn.SourceName = strings.Join(used, " and ")
	}
	rtn.State, rtn.Snapshot, rtn.Reason = GaugesEnabled, &merged, ""
	return rtn
}

// SetupOf returns what to paste for the best source turned on that is not set up, or nil.
func SetupOf(a UsageAdapter, settings *wconfig.SettingsType, cwd string) *UsageSetup {
	for _, s := range EnabledSources(a, settings) {
		ss, ok := s.(SetupSource)
		if !ok {
			continue
		}
		if setup := ss.Setup(cwd); setup != nil {
			return setup
		}
	}
	return nil
}

// ClearValues drops what an agent's sources read: hiding plan usage clears it (NFR-SHELL-011).
func ClearValues(a UsageAdapter) {
	if a == nil {
		return
	}
	for _, s := range a.Sources() {
		if c, ok := s.(interface{ Clear() }); ok {
			c.Clear()
		}
	}
}

// HasSources tells whether an agent has plan gauges at all, so the companion offers them.
func HasSources(a UsageAdapter) bool {
	return a != nil && len(a.Sources()) > 0
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
