// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
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

type usageRequest struct {
	BlockId string `json:"blockid"`
	Refresh bool   `json:"refresh,omitempty"`
}

type usageGaugesRequest struct {
	BlockId string `json:"blockid"`
	On      bool   `json:"on"`
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

func (m *Manager) Usage(blockId string, refresh bool) (UsageInfo, error) {
	agent, a, err := m.usageAdapter(blockId)
	if err != nil {
		return UsageInfo{}, err
	}
	return m.usageInfo(blockId, agent, a, m.currentSettings(), refresh), nil
}

// usageInfo reads the gauges with the given settings. A source the user sets up outside MoltenTerm that never
// reported is looked up, read-only, for the setup to show.
func (m *Manager) usageInfo(blockId string, agent string, a usage.UsageAdapter, settings *wconfig.SettingsType, refresh bool) UsageInfo {
	info := UsageInfo{BlockId: blockId, Agent: agent, PageURL: a.PageURL(), PageName: a.PageName(), HasGauges: usage.HasSources(a)}
	ctx, cancel := context.WithTimeout(usage.WithRefresh(context.Background(), refresh), usageReadTimeout)
	defer cancel()
	nowMs := m.now().UnixMilli()
	res := usage.ReadGauges(ctx, a, settings, blockId, nowMs)
	info.Gauges, info.Snapshot, info.Reason, info.SourceName = res.State, res.Snapshot, res.Reason, res.SourceName
	waiting := res.State == usage.GaugesUnavailable && res.Reason == usage.ReasonWaiting
	// Values that stopped coming may be those of a relay the user took out of the settings: they show, with their
	// age, only while the settings still run it.
	stale := res.State == usage.GaugesEnabled && res.Snapshot != nil && nowMs-res.Snapshot.ReadAt > usageStaleAfter.Milliseconds()
	if !waiting && !stale {
		return info
	}
	cwd := ""
	if m.blockInfo != nil {
		if bi, err := m.blockInfo(blockId); err == nil {
			cwd = bi.cwd
		}
	}
	if setup := usage.SetupOf(a, settings, cwd); setup != nil {
		info.Gauges, info.Reason, info.Setup, info.Snapshot = usage.GaugesUnavailable, usage.ReasonNotSetUp, setup, nil
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
	info := m.usageInfo(blockId, agent, a, &settings, false)
	for _, other := range m.OpenBlocks() {
		if other == blockId || m.blockAgent(other) != agent {
			continue
		}
		m.publishBlockUsage(m.usageInfo(other, agent, a, &settings, false))
	}
	return info, nil
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
	m.publishBlockUsage(m.usageInfo(req.BlockId, "claude", a, settings, false))
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

// settingsChanged clears what the sources of an agent read once the user turned its gauges off, from the companion
// or in settings.json.
func settingsChanged(settings *wconfig.SettingsType) {
	for _, agent := range usage.Agents() {
		if !usage.GaugesOn(settings, agent) {
			usage.ClearValues(usage.For(agent))
		}
	}
}
