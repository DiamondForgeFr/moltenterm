// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"log"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A workspace only ever shows its own tabs (#80). Since #68 the views of a workspace left stay alive, so a view can
// ask for one of its tabs while the window shows another workspace; Wave accepted it and the workspace then displayed,
// and saved changes into, another workspace's tab.

func checkTabInWorkspace(ws *waveobj.Workspace, tabId string) bool {
	return ws != nil && slices.Contains(ws.TabIds, tabId)
}

// Returns the active tab a workspace should have when the stored one is not one of its tabs, and whether it changed.
func repairedActiveTabId(ws *waveobj.Workspace) (string, bool) {
	if ws == nil || len(ws.TabIds) == 0 || checkTabInWorkspace(ws, ws.ActiveTabId) {
		return "", false
	}
	return ws.TabIds[0], true
}

// Workspaces saved before #80 can still point to another workspace's tab: they are repaired when shown.
func fixForeignActiveTab(ctx context.Context, ws *waveobj.Workspace) {
	newActiveTabId, changed := repairedActiveTabId(ws)
	if !changed {
		return
	}
	log.Printf("fixing workspace %q: active tab %q is not one of its tabs, using %q\n", ws.OID, ws.ActiveTabId, newActiveTabId)
	ws.ActiveTabId = newActiveTabId
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		log.Printf("error fixing the active tab of workspace %q: %v\n", ws.OID, err)
	}
}
