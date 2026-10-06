// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A network or process source (#262, #263) never holds the companion longer than this.
const usageReadTimeout = 10 * time.Second

// Unchanged windows are published again this often, so the gauges' age stays true.
const usageRepublishInterval = 30 * time.Second

// Values older than this are shown only while the source is still set up (must match UsageStaleMs in
// frontend/moltenterm-shell/companion/companion-gauges-model.ts).
const usageStaleAfter = 5 * time.Minute

// Fetch: the companion asks while its window shows, so a network source may call (NFR-SHELL-013).
type usageRequest struct {
	BlockId string `json:"blockid"`
	Refresh bool   `json:"refresh,omitempty"`
	Fetch   bool   `json:"fetch,omitempty"`
}

type usageGaugesRequest struct {
	BlockId string `json:"blockid"`
	On      bool   `json:"on"`
}

// ExperimentalInfo is the agent's experimental source as the companion offers it (FR-SHELL-028): whether the user
// turned it on, where it reads the credentials it uses (for the confirmation) and, when on, why it gave nothing.
type ExperimentalInfo struct {
	Source string `json:"source"`
	Name   string `json:"name"`
	On     bool   `json:"on"`
	Store  string `json:"store"`
	Reason string `json:"reason,omitempty"`
}

// UsageInfo answers `moltencompanionusage` (DS-SHELL-029, DS-SHELL-030): the agent's usage page, and its plan
// gauges when the user turned them on for the agent. It is also the data of the `molten:companionusage` event.
type UsageInfo struct {
	BlockId  string `json:"blockid"`
	Agent    string `json:"agent"`
	PageURL  string `json:"pageurl"`
	PageName string `json:"pagename"`
	// HasGauges: the agent has a gauges source, so the companion offers "Show plan usage".
	HasGauges  bool                 `json:"hasgauges,omitempty"`
	Gauges     string               `json:"gauges"`
	SourceName string               `json:"sourcename,omitempty"`
	Reason     string               `json:"reason,omitempty"`
	Setup      *usage.UsageSetup    `json:"setup,omitempty"`
	Snapshot   *usage.UsageSnapshot `json:"snapshot,omitempty"`
	// Experimental: only while the agent's gauges are on and it has such a source.
	Experimental *ExperimentalInfo `json:"experimental,omitempty"`
	// RefreshMs: how often a visible companion asks again, while a source that is not pushed is on.
	RefreshMs int64 `json:"refreshms,omitempty"`
}

// blockAgent is the agent the block's companion follows, else the one the agent states know.
func (m *Manager) blockAgent(blockId string) string {
	if w := m.watcher(blockId); w != nil {
		if run, ok := w.currentRun(); ok && run.Agent != "" {
			return run.Agent
		}
	}
	if m.runOf != nil {
		if run, ok := m.runOf(blockId); ok {
			return run.Agent
		}
	}
	return ""
}

func (m *Manager) currentSettings() *wconfig.SettingsType {
	if m.settings == nil {
		return nil
	}
	return m.settings()
}

func (m *Manager) usageAdapter(blockId string) (string, usage.UsageAdapter, error) {
	if blockId == "" {
		return "", nil, fmt.Errorf("no block")
	}
	agent := m.blockAgent(blockId)
	if agent == "" {
		return "", nil, fmt.Errorf("no agent runs in this terminal")
	}
	a := usage.For(agent)
	if a == nil {
		return agent, nil, fmt.Errorf("no usage page is known for %s", molten.AgentDisplayName(agent))
	}
	return agent, a, nil
}

// Usage answers the companion's own request; a refresh is the user's click, so it may call too.
func (m *Manager) Usage(blockId string, refresh bool) (UsageInfo, error) {
	return m.usageFor(usageRequest{BlockId: blockId, Refresh: refresh})
}

// usageFor answers `moltencompanionusage`: only a companion that shows may make a network source call
// (NFR-SHELL-013).
func (m *Manager) usageFor(req usageRequest) (UsageInfo, error) {
	agent, a, err := m.usageAdapter(req.BlockId)
	if err != nil {
		return UsageInfo{}, err
	}
	return m.usageInfo(req.BlockId, agent, a, m.currentSettings(), usageRead{refresh: req.Refresh, fetch: req.Fetch || req.Refresh}), nil
}

// usageRead says what a read may do: fetch lets a network source call, refresh is the user's Refresh.
type usageRead struct {
	refresh bool
	fetch   bool
}

// usageInfo reads the gauges with the given settings. A source the user sets up outside MoltenTerm that never
// reported is looked up, read-only, for the setup to show, unless another source gives the windows.
func (m *Manager) usageInfo(blockId string, agent string, a usage.UsageAdapter, settings *wconfig.SettingsType, read usageRead) UsageInfo {
	return m.usageInfoCtx(context.Background(), blockId, agent, a, settings, read)
}

func (m *Manager) usageInfoCtx(parent context.Context, blockId string, agent string, a usage.UsageAdapter, settings *wconfig.SettingsType, read usageRead) UsageInfo {
	info := UsageInfo{BlockId: blockId, Agent: agent, PageURL: a.PageURL(), PageName: a.PageName(), HasGauges: usage.HasSources(a)}
	ctx := usage.WithFetch(usage.WithRefresh(parent, read.refresh), read.fetch)
	ctx, cancel := context.WithTimeout(ctx, usageReadTimeout)
	defer cancel()
	nowMs := m.now().UnixMilli()
	res := usage.ReadGauges(ctx, a, settings, blockId, nowMs)
	info.Experimental = experimentalInfo(a, settings, res)
	info.RefreshMs = usage.RefreshEveryOf(a, settings).Milliseconds()
	info.Gauges, info.Snapshot, info.Reason, info.SourceName = res.State, res.Snapshot, res.Reason, res.SourceName
	waiting := res.State == usage.GaugesUnavailable && res.Reason == usage.ReasonWaiting
	// Values that stopped coming may be those of a relay the user took out of the settings: they show, with their
	// age, only while the settings still run it.
	stale := res.State == usage.GaugesEnabled && res.PushedStale(nowMs, usageStaleAfter.Milliseconds())
	if !waiting && !stale {
		return info
	}
	cwd := ""
	if m.blockInfo != nil {
		if bi, err := m.blockInfo(blockId); err == nil {
			cwd = bi.cwd
		}
	}
	setup := usage.SetupOf(a, settings, cwd)
	if setup == nil {
		// Still set up but quiet: a window another source still reports comes from it.
		if stale {
			fresh := res.FreshFirst(nowMs, usageStaleAfter.Milliseconds())
			info.Snapshot, info.SourceName = fresh.Snapshot, fresh.SourceName
		}
		return info
	}
	// Another source's windows (the experimental one's session and week) show rather than the setup.
	if other := res.Without(setup.Source, nowMs); other.State == usage.GaugesEnabled {
		info.Gauges, info.Snapshot, info.Reason, info.SourceName = other.State, other.Snapshot, "", other.SourceName
		return info
	}
	info.Gauges, info.Reason, info.Setup, info.Snapshot = usage.GaugesUnavailable, usage.ReasonNotSetUp, setup, nil
	return info
}

// experimentalInfo offers the agent's experimental source only while its gauges are on.
func experimentalInfo(a usage.UsageAdapter, settings *wconfig.SettingsType, res usage.GaugesResult) *ExperimentalInfo {
	src := usage.OptInOf(a)
	if src == nil || !usage.GaugesOn(settings, a.Id()) {
		return nil
	}
	on := src.OptedIn(settings)
	info := &ExperimentalInfo{Source: src.Id(), Name: src.Name(), On: on, Store: src.Store()}
	if on {
		info.Reason = res.Failures[src.Id()]
	}
	return info
}

// SetUsageGauges turns the plan gauges of the block's agent on or off, for that agent only, in
// `companion:usagegauges`; off clears what its sources read. The other open companions of the agent follow.
func (m *Manager) SetUsageGauges(blockId string, on bool) (UsageInfo, error) {
	agent, a, err := m.usageAdapter(blockId)
	if err != nil {
		return UsageInfo{}, err
	}
	if !usage.HasSources(a) {
		return UsageInfo{}, fmt.Errorf("no plan usage is known for %s yet", molten.AgentDisplayName(agent))
	}
	settings := wconfig.SettingsType{}
	if current := m.currentSettings(); current != nil {
		settings = *current
	}
	settings.CompanionUsageGauges = usage.WithGauges(settings.CompanionUsageGauges, agent, on)
	if m.writeGauges != nil {
		if err := m.writeGauges(settings.CompanionUsageGauges); err != nil {
			return UsageInfo{}, fmt.Errorf("the setting was not saved: %w", err)
		}
	}
	if !on {
		usage.ClearValues(a)
	}
	usage.SyncSources(a, &settings)
	// Showing plan usage is the user's click: an experimental source already turned on calls within the Refresh limit.
	info := m.usageInfo(blockId, agent, a, &settings, usageRead{refresh: on, fetch: on})
	m.publishAgentUsage(blockId, agent, a, &settings)
	return info, nil
}

// publishAgentUsage gives the agent's other open companions the gauges the settings now give, from memory only.
func (m *Manager) publishAgentUsage(blockId string, agent string, a usage.UsageAdapter, settings *wconfig.SettingsType) {
	for _, other := range m.OpenBlocks() {
		if other == blockId || m.blockAgent(other) != agent {
			continue
		}
		m.publishBlockUsage(m.usageInfo(other, agent, a, settings, usageRead{}))
	}
}

// SetUsageExperimental turns the experimental source of the block's agent on or off (FR-SHELL-028). On comes only
// from the companion's confirmation and needs the agent's gauges on; off stops its calls and forgets what it read.
func (m *Manager) SetUsageExperimental(blockId string, on bool) (UsageInfo, error) {
	agent, a, err := m.usageAdapter(blockId)
	if err != nil {
		return UsageInfo{}, err
	}
	src := usage.OptInOf(a)
	if src == nil {
		return UsageInfo{}, fmt.Errorf("no experimental usage source for %s", molten.AgentDisplayName(agent))
	}
	settings := wconfig.SettingsType{}
	if current := m.currentSettings(); current != nil {
		settings = *current
	}
	if on && !usage.GaugesOn(&settings, agent) {
		return UsageInfo{}, fmt.Errorf("show plan usage first")
	}
	// Stopped before the setting is written: a companion asking meanwhile, with the settings not yet reloaded,
	// makes no call.
	if !on {
		if c, ok := src.(interface{ Clear() }); ok {
			c.Clear()
		}
	}
	if m.writeSetting != nil {
		var value any
		if on {
			value = true
		}
		if err := m.writeSetting(src.SettingKey(), value); err != nil {
			return UsageInfo{}, fmt.Errorf("the setting was not saved: %w", err)
		}
	}
	src.SetOptIn(&settings, on)
	usage.SyncSources(a, &settings)
	// Turning it on is the user's click: it calls at once, within the Refresh limit.
	info := m.usageInfo(blockId, agent, a, &settings, usageRead{refresh: on, fetch: on})
	m.publishAgentUsage(blockId, agent, a, &settings)
	return info, nil
}

func writeUsageSetting(key string, value any) error {
	return wconfig.SetBaseConfigValue(waveobj.MetaMapType{key: value})
}

func writeGaugesSetting(agents []string) error {
	var value any
	if len(agents) > 0 {
		value = agents
	}
	return wconfig.SetBaseConfigValue(waveobj.MetaMapType{wconfig.ConfigKey_CompanionUsageGauges: value})
}

// RecordStatusLine keeps what `molten agent statusline` read of Claude Code's status line input, only while the user
// shows Claude Code's plan usage, and publishes the block's gauges when they changed.
func (m *Manager) RecordStatusLine(req molten.AgentStatusLineRequest) error {
	if req.BlockId == "" {
		return fmt.Errorf("molten agent statusline must run in a MoltenTerm terminal")
	}
	settings := m.currentSettings()
	if !usage.GaugesOn(settings, "claude") {
		return nil
	}
	if m.blockInfo != nil {
		info, err := m.blockInfo(req.BlockId)
		if err != nil {
			return err
		}
		if info.remote {
			return fmt.Errorf("no plan usage for a remote terminal")
		}
	}
	now := m.now()
	changed := usage.DefaultStatusLineStore.Record(req, now.UnixMilli())
	if !m.usageDue(req.BlockId, changed, now) {
		return nil
	}
	a := usage.For("claude")
	m.publishBlockUsage(m.usageInfo(req.BlockId, "claude", a, settings, usageRead{}))
	return nil
}

func (m *Manager) usageDue(blockId string, changed bool, now time.Time) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	last, ok := m.usagePublished[blockId]
	if !changed && ok && now.Sub(last) < usageRepublishInterval {
		return false
	}
	m.usagePublished[blockId] = now
	return true
}

func (m *Manager) publishBlockUsage(info UsageInfo) {
	if m.publishUsage == nil {
		return
	}
	m.publishUsage(info)
}

// settingsChanged clears what a source read once the user turned it off (the agent's gauges or the source's own
// opt-in), from the companion or in settings.json.
func settingsChanged(settings *wconfig.SettingsType) {
	for _, agent := range usage.Agents() {
		usage.SyncSources(usage.For(agent), settings)
	}
}

// CodexLimits is the Codex usage source's lookup (DS-SHELL-033): the plan limits of the Codex session the block's
// companion follows, read with the transcript; nothing else is opened for them.
func (m *Manager) CodexLimits(blockId string) (usage.CodexTranscriptLimits, bool) {
	w := m.watcher(blockId)
	if w == nil {
		return usage.CodexTranscriptLimits{}, false
	}
	return w.codexLimits()
}

func (w *watcher) codexLimits() (usage.CodexTranscriptLimits, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.agent != "codex" || w.session == nil {
		return usage.CodexTranscriptLimits{}, false
	}
	limits, _ := w.session.CodexLimits()
	limits.Loading = w.status == StatusLoading
	return limits, true
}

// limitsState: the session the loop follows for Codex, its limits' revision, and whether it was read through.
func (w *watcher) limitsState() (*Session, int64, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.agent != "codex" || w.session == nil {
		return nil, 0, false
	}
	return w.session, w.session.LimitsRev(), w.status == StatusLive
}

// publishLimitsIfChanged publishes the block's Codex gauges once its session is read through, and whenever a new
// token_count changes its limits, so they show within a tick of Codex writing them (FR-SHELL-029).
func (w *watcher) publishLimitsIfChanged() {
	session, rev, ready := w.limitsState()
	if session != w.limitsSession {
		w.limitsSession, w.limitsReady, w.limitsRev = session, false, 0
	}
	if session == nil || !ready {
		return
	}
	first := !w.limitsReady
	if !first && rev == w.limitsRev {
		return
	}
	w.limitsReady, w.limitsRev = true, rev
	w.m.codexLimitsChanged(w.blockId, first)
}

// codexLimitsChanged publishes a block's Codex gauges while they show. A new token_count never waits for a process;
// a session read through without any may start the app-server, off the companion's loop.
func (m *Manager) codexLimitsChanged(blockId string, first bool) {
	settings := m.currentSettings()
	if !usage.GaugesOn(settings, "codex") {
		return
	}
	a := usage.For("codex")
	if a == nil {
		return
	}
	if !first {
		m.publishBlockUsage(m.usageInfoCtx(usage.WithoutProcess(context.Background()), blockId, "codex", a, settings, usageRead{}))
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:companion:usage", recover())
		}()
		m.publishBlockUsage(m.usageInfo(blockId, "codex", a, settings, usageRead{}))
	}()
}
