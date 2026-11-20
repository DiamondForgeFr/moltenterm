// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The global plan usage (FR-SHELL-029, #2074): Brokk is global, and so is a plan. wavesrv reads each provider's limits for
// the whole app and publishes them without a block, so the gauges show with no companion terminal open.
// The automatic reads start no process or request: only Brokk's visible window lets a source fetch within its limits.

const globalUsageInterval = 2 * time.Minute

type globalUsageRequest struct {
	Fetch bool `json:"fetch,omitempty"`
}

// globalCodexInfo is Codex's global reading; ok is false when there is no Codex folder on this computer. Gauges off
// give "off", so Brokk drops what it showed.
func (m *Manager) globalCodexInfo(ctx context.Context) (UsageInfo, bool) {
	home := m.codexHome()
	if home == "" {
		return UsageInfo{}, false
	}
	a := usage.For(molten.AgentIdCodex)
	if a == nil {
		return UsageInfo{}, false
	}
	info := UsageInfo{Agent: molten.AgentIdCodex, Global: true, PageURL: a.PageURL(), PageName: a.PageName(), HasGauges: true}
	if !usage.GaugesOn(m.currentSettings(), molten.AgentIdCodex) {
		info.Gauges = usage.GaugesOff
		return info, true
	}
	ctx, cancel := context.WithTimeout(ctx, usageReadTimeout)
	defer cancel()
	snap, err := m.codexGlobal(ctx, home)
	if err != nil {
		info.Gauges, info.Reason = usage.GaugesUnavailable, usage.ReasonOf(err)
		return info, true
	}
	info.Gauges, info.Snapshot = usage.GaugesEnabled, &snap
	return info, true
}

func (m *Manager) globalKimiInfo(ctx context.Context) (UsageInfo, bool) {
	a := usage.For(molten.AgentIdKimi)
	if a == nil {
		return UsageInfo{}, false
	}
	info := UsageInfo{Agent: molten.AgentIdKimi, Global: true, PageURL: a.PageURL(), PageName: a.PageName(), HasGauges: usage.HasSources(a)}
	ctx, cancel := context.WithTimeout(ctx, usageReadTimeout)
	defer cancel()
	res := usage.ReadGauges(ctx, a, m.currentSettings(), "", m.now().UnixMilli())
	info.Gauges, info.Snapshot, info.Reason, info.SourceName = res.State, res.Snapshot, res.Reason, res.SourceName
	return info, true
}

func (m *Manager) codexHome() string {
	if m.codexHomeDir != nil {
		return m.codexHomeDir()
	}
	return usage.CodexHomeDir()
}

func (m *Manager) codexGlobal(ctx context.Context, home string) (usage.UsageSnapshot, error) {
	if m.readCodexGlobal != nil {
		return m.readCodexGlobal(ctx, home)
	}
	return usage.DefaultCodexUsage.ReadGlobal(ctx, home)
}

// GlobalUsage answers Brokk's request: the global readings, published too so every window has them. fetch: Brokk's
// window shows, so each source may fetch within its limits (NFR-SHELL-013).
func (m *Manager) GlobalUsage(fetch bool) []UsageInfo {
	ctx := usage.WithFetch(context.Background(), fetch)
	if !fetch {
		ctx = usage.WithoutProcess(ctx)
	}
	var infos [2]UsageInfo
	var present [2]bool
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer func() {
			panichandler.PanicHandler("molten:companion:globalusage:codex", recover())
		}()
		infos[0], present[0] = m.globalCodexInfo(ctx)
	}()
	go func() {
		defer wg.Done()
		defer func() {
			panichandler.PanicHandler("molten:companion:globalusage:kimi", recover())
		}()
		infos[1], present[1] = m.globalKimiInfo(ctx)
	}()
	wg.Wait()
	rtn := make([]UsageInfo, 0, len(infos))
	for i, info := range infos {
		if !present[i] {
			continue
		}
		m.publishGlobalIfChanged(info)
		rtn = append(rtn, info)
	}
	return rtn
}

// publishGlobalIfChanged publishes a global reading that differs from the last one published; Brokk counts its age.
func (m *Manager) publishGlobalIfChanged(info UsageInfo) {
	data, err := json.Marshal(info)
	if err != nil {
		return
	}
	m.lock.Lock()
	same := string(data) == m.globalPublished[info.Agent]
	m.globalPublished[info.Agent] = string(data)
	m.lock.Unlock()
	if same {
		return
	}
	m.publishBlockUsage(info)
}

// startGlobalUsage reads the global readings now and every two minutes, without fetching or starting a process.
func (m *Manager) startGlobalUsage() {
	go everyRecovered("molten:companion:globalusage", globalUsageInterval, true, nil, func() { m.GlobalUsage(false) })
}
