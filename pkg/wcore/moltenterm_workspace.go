// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var ErrLastWorkspace = errors.New("the only workspace of a window cannot be deleted: reset it instead")

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

// A workspace is deleted only when the user lands on another one (#222): Wave closed the window when its last
// workspace was deleted, which left the user without a workspace. The last one is reset instead (ResetWorkspace).

// windows holds every window; workspaces is Wave's list, which has only the saved workspaces.
func workspaceClosable(workspaces waveobj.WorkspaceList, windows []*waveobj.Window, workspaceId string) bool {
	shown := false
	for _, w := range windows {
		if w != nil && w.WorkspaceId == workspaceId {
			shown = true
		}
	}
	if !shown {
		return true
	}
	// Wave then closes the window that shows it, and the user is left with the other windows.
	if len(windows) > 1 {
		return true
	}
	for _, entry := range workspaces {
		if entry != nil && entry.WorkspaceId != workspaceId && entry.WindowId == "" {
			return true
		}
	}
	return false
}

func CheckWorkspaceClosable(ctx context.Context, workspaceId string) error {
	workspaces, err := ListWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("error listing workspaces: %w", err)
	}
	windows, err := wstore.DBGetAllObjsByType[*waveobj.Window](ctx, waveobj.OType_Window)
	if err != nil {
		return fmt.Errorf("error listing windows: %w", err)
	}
	if !workspaceClosable(workspaces, windows, workspaceId) {
		return ErrLastWorkspace
	}
	return nil
}

// Brings a workspace back to one new tab; its name, icon, colour and meta (the project link) are kept. The new tab is
// made before the old ones are deleted, so the workspace is never without a tab. Returns the new tab's id.
func ResetWorkspace(ctx context.Context, workspaceId string) (string, error) {
	ws, err := GetWorkspace(ctx, workspaceId)
	if err != nil {
		return "", fmt.Errorf("error getting workspace: %w", err)
	}
	oldTabIds := slices.Clone(ws.TabIds)
	noticeKeptWorktrees := moltenKeptWorktreesNotice(ctx, ws)
	// Named as in a new workspace: the old tabs still exist here and would make it "T<n+1>".
	newTabId, err := CreateTab(ctx, workspaceId, getNextTabName(nil), true, false)
	if err != nil {
		return "", fmt.Errorf("error creating tab: %w", err)
	}
	for _, tabId := range oldTabIds {
		if _, err := DeleteTab(ctx, workspaceId, tabId, false); err != nil {
			log.Printf("error deleting tab %q while resetting workspace %q: %v\n", tabId, workspaceId, err)
		}
	}
	noticeKeptWorktrees()
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_WorkspaceUpdate})
	return newTabId, nil
}
