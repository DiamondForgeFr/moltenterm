// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// moltenMetaCaller is who sent a request (NFR-FORK-001). A call with no response handler comes from wavesrv's own
// code, not through the router. needWorkspace looks up a terminal's workspace, for the rules that depend on it.
func moltenMetaCaller(ctx context.Context, needWorkspace bool) metaguard.Caller {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return metaguard.Caller{Trusted: true}
	}
	caller := metaguard.CallerOf(wshutil.DefaultRouter, handler.GetSource(), handler.GetIngressLinkId())
	if !needWorkspace || caller.Trusted || caller.BlockId == "" {
		return caller
	}
	caller.WorkspaceId = moltenWorkspaceOf(ctx, waveobj.MakeORef(waveobj.OType_Block, caller.BlockId))
	return caller
}

// moltenWorkspaceOf is the workspace a block or a tab is in, "" when unknown.
func moltenWorkspaceOf(ctx context.Context, oref waveobj.ORef) string {
	tabId := oref.OID
	switch oref.OType {
	case waveobj.OType_Tab:
	case waveobj.OType_Block:
		found, err := wstore.DBFindTabForBlockId(ctx, oref.OID)
		if err != nil {
			return ""
		}
		tabId = found
	default:
		return ""
	}
	if tabId == "" {
		return ""
	}
	wsId, _ := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	return wsId
}

func moltenInWorkspace(ctx context.Context, caller metaguard.Caller, oref waveobj.ORef) bool {
	return caller.WorkspaceId != "" && moltenWorkspaceOf(ctx, oref) == caller.WorkspaceId
}

func moltenCheckMetaWrite(ctx context.Context, oref waveobj.ORef, meta waveobj.MetaMapType) error {
	return metaguard.CheckWrite(moltenMetaCaller(ctx, oref.OType == waveobj.OType_Workspace), oref, meta)
}

func moltenReadMeta(ctx context.Context, oref waveobj.ORef, meta waveobj.MetaMapType) (waveobj.MetaMapType, error) {
	switch oref.OType {
	case waveobj.OType_Workspace:
		return metaguard.ReadMeta(moltenMetaCaller(ctx, true), oref, meta)
	case waveobj.OType_Block:
		caller := moltenMetaCaller(ctx, true)
		if caller.Trusted || caller.BlockId == oref.OID {
			return meta, nil
		}
		return metaguard.ReadBlockMeta(caller, moltenInWorkspace(ctx, caller, oref), meta), nil
	}
	return meta, nil
}

func moltenListedWorkspaces(ctx context.Context, workspaces []wshrpc.WorkspaceInfoData) {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return
	}
	for i, entry := range workspaces {
		if entry.WorkspaceData == nil {
			continue
		}
		listed := *entry.WorkspaceData
		listed.Meta = metaguard.ListedWorkspaceMeta(caller, listed.OID, listed.Meta)
		workspaces[i].WorkspaceData = &listed
	}
}

func moltenListedBlocks(ctx context.Context, blocks []wshrpc.BlocksListEntry) {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return
	}
	for i := range blocks {
		blocks[i].Meta = metaguard.ReadBlockMeta(caller, caller.WorkspaceId != "" && blocks[i].WorkspaceId == caller.WorkspaceId, blocks[i].Meta)
	}
}

func moltenCheckPublish(ctx context.Context, event string) error {
	return metaguard.CheckPublish(moltenMetaCaller(ctx, false), event)
}

func moltenCheckSubscribe(ctx context.Context, req wps.SubscriptionRequest) error {
	if req.Event != wps.Event_WaveObjUpdate {
		return nil
	}
	caller := moltenMetaCaller(ctx, true)
	return metaguard.CheckSubscribe(caller, req, func(oref waveobj.ORef) bool { return moltenInWorkspace(ctx, caller, oref) })
}

func moltenCheckCreateBlock(ctx context.Context, tabId string, blockDef *waveobj.BlockDef) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return nil
	}
	var meta waveobj.MetaMapType
	if blockDef != nil {
		meta = blockDef.Meta
	}
	return metaguard.CheckCreateBlock(caller, moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Tab, tabId)), meta)
}

// moltenCheckTabOrder: a terminal reorders its own workspace's tabs, never adds or drops one.
func moltenCheckTabOrder(ctx context.Context, workspaceId string, tabIds []string) error {
	oref := waveobj.MakeORef(waveobj.OType_Workspace, workspaceId)
	if err := moltenCheckOwnWorkspace(ctx, oref, "reorder tabs"); err != nil {
		return err
	}
	caller := moltenMetaCaller(ctx, false)
	if caller.Trusted {
		return nil
	}
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil || ws == nil {
		return fmt.Errorf("workspace not found: %q", workspaceId)
	}
	return metaguard.CheckTabOrder(caller, ws.TabIds, tabIds)
}

func moltenCheckOwnWorkspace(ctx context.Context, oref waveobj.ORef, what string) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return nil
	}
	wsId := oref.OID
	if oref.OType != waveobj.OType_Workspace {
		wsId = moltenWorkspaceOf(ctx, oref)
	}
	return metaguard.CheckOwnWorkspace(caller, wsId, what)
}
