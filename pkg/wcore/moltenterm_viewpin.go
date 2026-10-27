// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Pinned views (FR-SHELL-080): the window reads a view's configuration to pin it, and makes a view from one, in a
// new tab (a view pinned everywhere opened in a workspace) or in place of a tab's panels (back to the pinned state).
// The view is made by splits, the way a reopened tab is (reopen.LayoutLeaves, restoreTab).

func workspaceProjectDir(ctx context.Context, workspaceId string) string {
	ws, err := GetWorkspace(ctx, workspaceId)
	if err != nil || ws == nil {
		return ""
	}
	return ws.Meta.GetString(viewpin.ProjectMetaKey, "")
}

func captureViewPin(ctx context.Context, req viewpin.CaptureRequest) (viewpin.Config, error) {
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, req.TabId)
	if err != nil {
		return viewpin.Config{}, err
	}
	agents := map[string]bool{}
	for _, id := range req.AgentBlocks {
		agents[id] = true
	}
	repoUrl := viewpin.RepoWebUrl(workspaceProjectDir(ctx, req.WorkspaceId))
	metaOf := func(blockId string) (waveobj.MetaMapType, bool) {
		if !slices.Contains(tab.BlockIds, blockId) {
			return nil, false
		}
		block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if block == nil {
			return nil, false
		}
		return block.Meta, true
	}
	cfg := viewpin.Capture(req.Tree, agents, repoUrl, metaOf)
	if len(cfg.Panes) == 0 {
		return viewpin.Config{}, fmt.Errorf("the view has no panel to pin")
	}
	return cfg, nil
}

func buildViewPin(ctx context.Context, req viewpin.BuildRequest) (viewpin.BuildResult, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	defer func() {
		updates := waveobj.ContextGetUpdatesRtn(ctx)
		if len(updates) == 0 {
			return
		}
		go func() {
			defer func() {
				panichandler.PanicHandler("buildViewPin:SendUpdateEvents", recover())
			}()
			wps.Broker.SendUpdateEvents(updates)
		}()
	}()
	dir := workspaceProjectDir(ctx, req.WorkspaceId)
	repoUrl := viewpin.RepoWebUrl(dir)
	panes := req.Config.Panes
	metaOf := func(blockId string) (map[string]any, bool) {
		idx, err := strconv.Atoi(strings.TrimPrefix(blockId, "p"))
		if err != nil || idx < 0 || idx >= len(panes) {
			return nil, false
		}
		return viewpin.ResolvePane(panes[idx], dir, repoUrl), true
	}
	leaves := reopen.LayoutLeaves(viewpin.LayoutRoot(req.Config.Tree), "", metaOf)
	if len(leaves) == 0 {
		return viewpin.BuildResult{}, fmt.Errorf("the view has no panel to open")
	}
	leaves[0].Focused = true
	tabId := req.TabId
	var oldBlocks []string
	if tabId == "" {
		newId, err := makePinnedTab(ctx, req)
		if err != nil {
			return viewpin.BuildResult{}, err
		}
		tabId = newId
	} else {
		tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
		if err != nil {
			return viewpin.BuildResult{}, err
		}
		oldBlocks = slices.Clone(tab.BlockIds)
	}
	actions := []waveobj.LayoutActionData{{ActionType: LayoutActionDataType_ClearTree}}
	blockIds := make([]string, len(leaves))
	for i, leaf := range leaves {
		block, err := CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{Meta: leaf.Meta}, &waveobj.RuntimeOpts{}, false)
		if err != nil {
			log.Printf("molten: opening a panel of a pinned view: %v\n", err)
			continue
		}
		blockIds[i] = block.OID
		actions = append(actions, tabLeafAction(leaf, block.OID, blockIds))
	}
	if err := QueueLayoutActionForTab(ctx, tabId, actions...); err != nil {
		return viewpin.BuildResult{TabId: tabId}, err
	}
	for _, id := range oldBlocks {
		if err := DeleteBlock(ctx, id, false); err != nil {
			log.Printf("molten: removing a panel replaced by the pinned state: %v\n", err)
		}
	}
	if req.TabId == "" {
		SendActiveTabUpdate(ctx, req.WorkspaceId, tabId)
	}
	return viewpin.BuildResult{TabId: tabId}, nil
}

// makePinnedTab adds the view's tab at the end of the workspace's tabs and makes it the active one.
func makePinnedTab(ctx context.Context, req viewpin.BuildRequest) (string, error) {
	return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (string, error) {
		tctx := tx.Context()
		tab, err := createTabObj(tctx, req.WorkspaceId, req.Name, req.TabMeta)
		if err != nil {
			return "", err
		}
		ws, err := GetWorkspace(tctx, req.WorkspaceId)
		if err != nil {
			return "", err
		}
		ws.ActiveTabId = tab.OID
		if err := wstore.DBUpdate(tctx, ws); err != nil {
			return "", err
		}
		return tab.OID, nil
	})
}

// StartViewPinRoute lets the windows pin views and open them; wavesrv calls it once.
func StartViewPinRoute() {
	viewpin.StartRoute(viewpin.Store{Capture: captureViewPin, Build: buildViewPin})
}
