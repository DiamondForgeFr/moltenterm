// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package browseragent owns the agent sessions of `molten mcp browser` in wavesrv (FR-BRW-008, DS-BRW-010/011/020):
// who a session is (from the pane's verified token, never from tool input), which browser tabs it may address (the
// tabs it opened and the tabs the user shared with it, in its pane's workspace), the tools, Stop and takeover, the
// state the panels show, and the audit log. The MCP server process only carries calls here.
package browseragent

import (
	"context"
	"encoding/json"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	TabStateActive    = "active"
	TabStateTakenOver = "takenover"
	TabStateStopped   = "stopped"

	OriginOpened = "opened"
	OriginShared = "shared"

	ControlStop     = "stop"
	ControlTakeOver = "takeover"
	ControlGiveBack = "giveback"

	TermView = "term"
)

// BlockLocation is where a block is now: re-read on every call, so a pane moved to another tab or workspace is scoped
// to where it is.
type BlockLocation struct {
	TabId       string
	WorkspaceId string
	View        string
	// Local: the terminal runs on this computer. A pane on an SSH or WSL connection may not drive the local browser,
	// which holds the user's sign-ins and reaches localhost.
	Local bool
}

type Panel struct {
	BlockId     string
	TabId       string
	WorkspaceId string
	Tabs        []molten.BrowserPanelTab
}

func (p Panel) findTab(browserTabId string) (molten.BrowserPanelTab, bool) {
	for _, t := range p.Tabs {
		if t.Id == browserTabId {
			return t, true
		}
	}
	return molten.BrowserPanelTab{}, false
}

type OpenTabRequest struct {
	TermBlockId string
	TabId       string
	// PanelId is the panel to open the tab in; "" creates a panel next to the terminal.
	PanelId      string
	BrowserTabId string
	Url          string
}

type TabKey struct {
	PanelId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
}

// ActionCue tells the panel where an action happens (DS-BRW-011): a pointer at X,Y and/or an outline of the element's
// box, in the page's CSS pixels. FR-BRW-010's input tools fill it.
type ActionCue struct {
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Width  float64 `json:"width,omitempty"`
	Height float64 `json:"height,omitempty"`
	Kind   string  `json:"kind"`
}

// PanelAgentTab is what a panel shows for one controlled tab. Must match frontend/moltenterm-shell/browser/browser-agent.ts.
type PanelAgentTab struct {
	BrowserTabId string     `json:"browsertabid"`
	AgentName    string     `json:"agentname"`
	Origin       string     `json:"origin"`
	State        string     `json:"state"`
	Action       string     `json:"action,omitempty"`
	ActionTs     int64      `json:"actionts,omitempty"`
	Cue          *ActionCue `json:"cue,omitempty"`
}

type PanelState struct {
	BlockId string          `json:"blockid"`
	Tabs    []PanelAgentTab `json:"tabs"`
}

type ControlRequest struct {
	BlockId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
	Action       string `json:"action"`
}

type StateRequest struct {
	BlockId string `json:"blockid"`
}

// Env is what the sessions need from wavesrv, the windows and emain; tests replace it.
type Env interface {
	// VerifyToken checks a pane's WAVETERM_JWT signature and returns the block it was issued for.
	VerifyToken(token string) (string, error)
	LocateBlock(ctx context.Context, blockId string) (BlockLocation, error)
	// TabPanels lists the browser panels of a Wave tab in layout order, with the tab's focus history
	// (molten.BrowserRecentMetaKey).
	TabPanels(ctx context.Context, tabId string) ([]string, any, error)
	// ReadPanel returns a panel and where it is; false when the block is gone or is not a browser panel.
	ReadPanel(ctx context.Context, panelId string) (Panel, bool, error)
	// AgentName is the display name of the agent detected in the terminal block, "" when none is.
	AgentName(blockId string) string
	// OpenTab queues the tab in its panel (or creates the panel) and returns the panel's block id.
	OpenTab(ctx context.Context, req OpenTabRequest) (string, error)
	// CloseTab closes a panel tab; a tab still queued for opening is closed as soon as it opens.
	CloseTab(ctx context.Context, key TabKey) error
	// Cdp runs one DevTools method on the tab's webview through emain's allow-list (DS-BRW-012).
	Cdp(ctx context.Context, key TabKey, method string, params any) (json.RawMessage, error)
	// SetControl tells emain whether a tab is driven by an agent: takeover detection, no background throttling,
	// and detaching the debugger when control ends.
	SetControl(key TabKey, controlled bool)
	Publish(state PanelState)
}
