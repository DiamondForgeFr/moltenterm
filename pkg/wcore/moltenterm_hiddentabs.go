// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// CreateAgentTab makes a tab for an agent MoltenTerm starts on the developer's request (#758), never activated: hidden
// (out of sight, pkg/molten/hiddentabs.go) or shown in the tab bar for the window to activate. The tab and its place in
// the hidden list reach the windows in one update, so a hidden tab never flashes in the tab bar.
func CreateAgentTab(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType, hidden bool) (string, error) {
	if workspaceId == "" {
		return "", fmt.Errorf("workspaceid is required")
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	tab, err := createTabObj(ctx, workspaceId, name, meta)
	if err != nil {
		return "", err
	}
	if hidden {
		ws, err := GetWorkspace(ctx, workspaceId)
		if err != nil {
			return "", err
		}
		molten.SetHiddenTabIds(ws, append(molten.HiddenTabIds(ws), tab.OID))
		wstore.DBUpdate(ctx, ws)
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Workspace, workspaceId))
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, tab.OID))
	return tab.OID, nil
}

// CloseAgentTab takes away an agent's tab whose terminal could not be made.
func CloseAgentTab(ctx context.Context, tabId string) error {
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil || workspaceId == "" {
		return fmt.Errorf("the tab %s is in no workspace: %v", tabId, err)
	}
	return closeTabOf(ctx, workspaceId, tabId)
}

func closeTabOf(ctx context.Context, workspaceId string, tabId string) error {
	ctx = waveobj.ContextWithUpdates(ctx)
	ws, err := GetWorkspace(ctx, workspaceId)
	if err != nil {
		return err
	}
	wasActive := ws.ActiveTabId == tabId
	newActiveTabId, err := DeleteTab(ctx, workspaceId, tabId, false)
	if err != nil {
		return err
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Workspace, workspaceId))
	if wasActive && newActiveTabId != "" {
		SendActiveTabUpdate(ctx, workspaceId, newActiveTabId)
	}
	return nil
}

// CloseAgentTerminal closes the terminal of an agent that finished cleanly (#758), and its tab when nothing else is
// there (the developer did not keep working in it).
func CloseAgentTerminal(ctx context.Context, blockId string) error {
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil || tabId == "" {
		return DeleteBlock(ctx, blockId, false)
	}
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	workspaceId, _ := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if tab != nil && workspaceId != "" && len(tab.BlockIds) == 1 && tab.BlockIds[0] == blockId {
		ws, _ := GetWorkspace(ctx, workspaceId)
		// The workspace's last tab stays: closing it would close the window.
		if ws != nil && len(ws.TabIds) > 1 {
			return closeTabOf(ctx, workspaceId, tabId)
		}
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	if err := DeleteBlock(ctx, blockId, false); err != nil {
		return err
	}
	QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{ActionType: LayoutActionDataType_Remove, BlockId: blockId})
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return nil
}

func moltenRevealTab(ws *waveobj.Workspace, tabId string) {
	molten.RevealTab(ws, tabId)
}

// moltenRememberActiveTab keeps the active tab in the workspace's history before next replaces it (#1345).
func moltenRememberActiveTab(ws *waveobj.Workspace, next string) {
	molten.RememberActiveTab(ws, next)
}

func moltenKeepHiddenTabs(ws *waveobj.Workspace, tabIds []string) []string {
	return molten.KeepHiddenTabs(ws, tabIds)
}

// moltenForgetClosedTabs drops the closed tabs (no longer in ws.TabIds) from the hidden list.
func moltenForgetClosedTabs(ws *waveobj.Workspace) {
	if _, ok := ws.Meta[molten.HiddenTabsMetaKey]; ok {
		molten.SetHiddenTabIds(ws, molten.HiddenTabIds(ws))
	}
}

// moltenNextActiveTab is the tab shown once the active tab at idx (already out of ws.TabIds) is closed: a shown tab
// near it. When only hidden tabs remain they are revealed: the developer closed every other tab, and the agents' tabs
// say why they are there. A tab opened from another tab goes back to that tab when it is still shown (#892); any other
// goes back to the view shown before it (#1345).
func moltenNextActiveTab(ws *waveobj.Workspace, idx int, closed *waveobj.Tab) string {
	hidden := molten.HiddenTabIds(ws)
	moltenForgetClosedTabs(ws)
	if len(ws.TabIds) == 0 {
		return ""
	}
	if closed != nil {
		if opener := molten.ShownOpener(ws.TabIds, hidden, closed.Meta.GetString(molten.OpenerTabMetaKey, "")); opener != "" {
			return opener
		}
	}
	if previous := molten.PreviousShownTab(ws, hidden); previous != "" {
		return previous
	}
	if next := molten.VisibleNeighbour(ws.TabIds, hidden, idx); next != "" {
		return next
	}
	molten.SetHiddenTabIds(ws, nil)
	return ws.TabIds[max(0, min(idx-1, len(ws.TabIds)-1))]
}
