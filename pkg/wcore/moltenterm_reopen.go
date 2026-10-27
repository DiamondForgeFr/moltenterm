// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Reopening the last closed pane or tab (#512): the window records what it is about to close, read here from the
// store before it goes, and asks for the last one back. A terminal comes back with a new shell in its folder and on
// its connection: closing it ended its shell and its durable job (jobcontroller ends the job of a closed block).

func captureReopen(ctx context.Context, req reopen.RecordRequest) (reopen.Entry, error) {
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, req.TabId)
	if err != nil {
		return reopen.Entry{}, err
	}
	layout, _ := wstore.DBGet[*waveobj.LayoutState](ctx, tab.LayoutState)
	var root any
	focused := ""
	if layout != nil {
		root, focused = layout.RootNode, layout.FocusedNodeId
	}
	if req.Root != nil {
		root = req.Root
	}
	e := reopen.Entry{
		At:     time.Now().UnixMilli(),
		Actor:  reopen.ActorUser,
		Action: reopen.ActionClose,
		Target: reopen.Target{Kind: req.Kind, WorkspaceId: req.WorkspaceId, TabId: req.TabId, BlockId: req.BlockId},
	}
	if req.Kind == reopen.KindPane {
		block, err := wstore.DBMustGet[*waveobj.Block](ctx, req.BlockId)
		if err != nil {
			return reopen.Entry{}, err
		}
		meta := withResumeAgent(req.BlockId, reopen.CleanMeta(block.Meta))
		e.Target.Name = reopen.PaneName(meta)
		place, indexArr := reopen.PanePlacement(root, req.BlockId)
		e.Pane = &reopen.Pane{Meta: meta, PanePlacement: place, IndexArr: indexArr}
		return e, nil
	}
	ws, err := GetWorkspace(ctx, req.WorkspaceId)
	if err != nil {
		return reopen.Entry{}, err
	}
	metaOf := func(blockId string) (map[string]any, bool) {
		if !slices.Contains(tab.BlockIds, blockId) {
			return nil, false
		}
		block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if block == nil {
			return nil, false
		}
		return withResumeAgent(blockId, reopen.CleanMeta(block.Meta)), true
	}
	e.Target.Name = tab.Name
	e.Tab = &reopen.Tab{
		Name:   tab.Name,
		Index:  max(slices.Index(ws.TabIds, req.TabId), 0),
		Meta:   reopen.CleanMeta(tab.Meta),
		Leaves: reopen.LayoutLeaves(root, focused, metaOf),
	}
	return e, nil
}

// withResumeAgent notes the agent a closing terminal runs, so the terminal reopened from the library starts it again
// on its session (FR-SHELL-088).
func withResumeAgent(blockId string, meta waveobj.MetaMapType) waveobj.MetaMapType {
	if meta.GetString(waveobj.MetaKey_View, "") != "term" {
		return meta
	}
	delete(meta, reopen.ResumeAgentMetaKey)
	if agent, ok := reopen.AgentOf(blockId); ok {
		meta[reopen.ResumeAgentMetaKey] = reopen.ResumeAgentMeta(agent)
	}
	return meta
}

func restoreReopen(ctx context.Context, e reopen.Entry, req reopen.ReopenRequest) (reopen.ReopenResult, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	defer func() {
		updates := waveobj.ContextGetUpdatesRtn(ctx)
		if len(updates) == 0 {
			return
		}
		go func() {
			defer func() {
				panichandler.PanicHandler("restoreReopen:SendUpdateEvents", recover())
			}()
			wps.Broker.SendUpdateEvents(updates)
		}()
	}()
	switch {
	case e.Pane != nil:
		return restorePane(ctx, e, req)
	case e.Tab != nil:
		return restoreTab(ctx, e)
	}
	return reopen.ReopenResult{}, fmt.Errorf("nothing to reopen in this entry")
}

func freshShellResult(meta waveobj.MetaMapType, rtn *reopen.ReopenResult) {
	if meta.GetString(waveobj.MetaKey_View, "") == "term" {
		rtn.FreshShell = true
		rtn.Cwd = meta.GetString(waveobj.MetaKey_CmdCwd, "")
	}
}

// restorePane puts the pane back in its tab, or in the tab shown when its tab is gone, beside the panel it sat next
// to when that panel is still there.
func restorePane(ctx context.Context, e reopen.Entry, req reopen.ReopenRequest) (reopen.ReopenResult, error) {
	tabId := e.Target.TabId
	if tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId); tab == nil {
		tabId = req.TabId
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return reopen.ReopenResult{}, err
	}
	block, err := CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{Meta: e.Pane.Meta}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		return reopen.ReopenResult{}, err
	}
	action := waveobj.LayoutActionData{ActionType: LayoutActionDataType_Insert, BlockId: block.OID, Focused: true}
	if horizontal, position, ok := e.Pane.SplitAction(); ok && slices.Contains(tab.BlockIds, e.Pane.TargetBlockId) {
		action.ActionType = LayoutActionDataType_SplitVertical
		if horizontal {
			action.ActionType = LayoutActionDataType_SplitHorizontal
		}
		action.TargetBlockId, action.Position = e.Pane.TargetBlockId, position
	} else if len(e.Pane.IndexArr) > 0 && tabId == e.Target.TabId {
		indexArr := slices.Clone(e.Pane.IndexArr)
		action.ActionType, action.IndexArr = LayoutActionDataType_InsertAtIndex, &indexArr
	}
	if err := QueueLayoutActionForTab(ctx, tabId, action); err != nil {
		return reopen.ReopenResult{}, err
	}
	rtn := reopen.ReopenResult{TabId: tabId, BlockId: block.OID}
	freshShellResult(e.Pane.Meta, &rtn)
	if tabId != req.TabId {
		if err := SetActiveTab(ctx, e.Target.WorkspaceId, tabId); err == nil {
			SendActiveTabUpdate(ctx, e.Target.WorkspaceId, tabId)
		}
	}
	return rtn, nil
}

// restoreTab makes the tab again at its place in the strip, then its panes by splits (reopen.LayoutLeaves).
func restoreTab(ctx context.Context, e reopen.Entry) (reopen.ReopenResult, error) {
	wsId := e.Target.WorkspaceId
	tabId, err := wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (string, error) {
		tctx := tx.Context()
		tab, err := createTabObj(tctx, wsId, e.Tab.Name, e.Tab.Meta)
		if err != nil {
			return "", err
		}
		ws, err := GetWorkspace(tctx, wsId)
		if err != nil {
			return "", err
		}
		ids := slices.DeleteFunc(slices.Clone(ws.TabIds), func(id string) bool { return id == tab.OID })
		ws.TabIds = slices.Insert(ids, min(e.Tab.Index, len(ids)), tab.OID)
		ws.ActiveTabId = tab.OID
		if err := wstore.DBUpdate(tctx, ws); err != nil {
			return "", err
		}
		return tab.OID, nil
	})
	if err != nil {
		return reopen.ReopenResult{}, fmt.Errorf("making the tab again: %w", err)
	}
	leaves := e.Tab.Leaves
	if len(leaves) == 0 {
		leaves = []reopen.Leaf{{Meta: GetNewTabLayout()[0].BlockDef.Meta, Target: -1}}
	}
	rtn := reopen.ReopenResult{TabId: tabId, Name: e.Tab.Name}
	actions := []waveobj.LayoutActionData{{ActionType: LayoutActionDataType_ClearTree}}
	blockIds := make([]string, len(leaves))
	for i, leaf := range leaves {
		block, err := CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{Meta: leaf.Meta}, &waveobj.RuntimeOpts{}, false)
		if err != nil {
			log.Printf("molten: reopening a pane of tab %q: %v\n", e.Tab.Name, err)
			continue
		}
		blockIds[i] = block.OID
		freshShellResult(leaf.Meta, &rtn)
		actions = append(actions, tabLeafAction(leaf, block.OID, blockIds))
	}
	if err := QueueLayoutActionForTab(ctx, tabId, actions...); err != nil {
		return rtn, err
	}
	SendActiveTabUpdate(ctx, wsId, tabId)
	return rtn, nil
}

// tabLeafAction places one pane of a reopened tab: the first fills it, the next split the pane they sat beside.
func tabLeafAction(leaf reopen.Leaf, blockId string, placed []string) waveobj.LayoutActionData {
	action := waveobj.LayoutActionData{ActionType: LayoutActionDataType_Insert, BlockId: blockId, Focused: leaf.Focused}
	if leaf.Target < 0 || leaf.Target >= len(placed) || placed[leaf.Target] == "" {
		return action
	}
	place := molten.PanePlacement{TargetBlockId: placed[leaf.Target], Split: leaf.Split}
	if horizontal, position, ok := place.SplitAction(); ok {
		action.ActionType = LayoutActionDataType_SplitVertical
		if horizontal {
			action.ActionType = LayoutActionDataType_SplitHorizontal
		}
		action.TargetBlockId, action.Position = place.TargetBlockId, position
	}
	return action
}

// StartReopenRoute lets the windows record their closes and reopen the last one; wavesrv calls it once.
func StartReopenRoute() {
	termupdate.StartReopenAgents()
	reopen.StartRoute(reopen.Store{Capture: captureReopen, Restore: restoreReopen})
}
