// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A network or process source (#262, #263) never holds the companion longer than this.
const usageReadTimeout = 10 * time.Second

type usageRequest struct {
	BlockId string `json:"blockid"`
}

// UsageInfo answers `moltencompanionusage` (DS-SHELL-029): the agent's usage page, and its plan gauges when the user
// turned a source on.
type UsageInfo struct {
	Agent    string               `json:"agent"`
	PageURL  string               `json:"pageurl"`
	PageName string               `json:"pagename"`
	Gauges   string               `json:"gauges"`
	Snapshot *usage.UsageSnapshot `json:"snapshot,omitempty"`
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

func (m *Manager) Usage(blockId string) (UsageInfo, error) {
	if blockId == "" {
		return UsageInfo{}, fmt.Errorf("no block")
	}
	agent := m.blockAgent(blockId)
	if agent == "" {
		return UsageInfo{}, fmt.Errorf("no agent runs in this terminal")
	}
	a := usage.For(agent)
	if a == nil {
		return UsageInfo{}, fmt.Errorf("no usage page is known for %s", molten.AgentDisplayName(agent))
	}
	info := UsageInfo{Agent: agent, PageURL: a.PageURL(), PageName: a.PageName()}
	var settings *wconfig.SettingsType
	if m.settings != nil {
		settings = m.settings()
	}
	ctx, cancel := context.WithTimeout(context.Background(), usageReadTimeout)
	defer cancel()
	info.Gauges, info.Snapshot = usage.ReadGauges(ctx, a, settings, blockId, m.now().UnixMilli())
	return info, nil
}
