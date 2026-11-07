// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"context"
	"encoding/json"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The global plan usage (FR-SHELL-029, #2074): Brokk is global, and so is a plan. wavesrv reads Codex's limits for the
// whole app, from its folder, and publishes them without a block, so the gauge shows with no Codex terminal open.
// The automatic reads start no process: only Brokk's window, while it shows, lets the app-server run.

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
// window shows, so the app-server may run within its limits (NFR-SHELL-013).
func (m *Manager) GlobalUsage(fetch bool) []UsageInfo {
	ctx := usage.WithFetch(context.Background(), fetch)
	if !fetch {
		ctx = usage.WithoutProcess(ctx)
	}
	info, ok := m.globalCodexInfo(ctx)
	if !ok {
		return []UsageInfo{}
	}
	m.publishGlobalIfChanged(info)
	return []UsageInfo{info}
}

// publishGlobalIfChanged publishes a global reading that differs from the last one published; Brokk counts its age.
func (m *Manager) publishGlobalIfChanged(info UsageInfo) {
	data, err := json.Marshal(info)
	if err != nil {
		return
	}
	m.lock.Lock()
	same := string(data) == m.globalPublished
	m.globalPublished = string(data)
	m.lock.Unlock()
	if same {
		return
	}
	m.publishBlockUsage(info)
}

// startGlobalUsage reads the global readings now and every two minutes, from the folder only.
func (m *Manager) startGlobalUsage() {
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:companion:globalusage", recover())
		}()
		for {
			m.GlobalUsage(false)
			time.Sleep(globalUsageInterval)
		}
	}()
}
