// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// moltenMetaCaller is who sent a meta request (NFR-FORK-001). A call with no response handler comes from wavesrv's
// own code, not through the router. needWorkspace looks up a terminal's workspace, for the rules on workspace meta.
func moltenMetaCaller(ctx context.Context, needWorkspace bool) metaguard.Caller {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return metaguard.Caller{Trusted: true}
	}
	caller := metaguard.CallerOf(wshutil.DefaultRouter, handler.GetSource(), handler.GetIngressLinkId())
	if !needWorkspace || caller.Trusted || caller.BlockId == "" {
		return caller
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, caller.BlockId)
	if err != nil || tabId == "" {
		return caller
	}
	caller.WorkspaceId, _ = wstore.DBFindWorkspaceForTabId(ctx, tabId)
	return caller
}

func moltenCheckMetaWrite(ctx context.Context, oref waveobj.ORef, meta waveobj.MetaMapType) error {
	return metaguard.CheckWrite(moltenMetaCaller(ctx, oref.OType == waveobj.OType_Workspace), oref, meta)
}

func moltenReadMeta(ctx context.Context, oref waveobj.ORef, meta waveobj.MetaMapType) (waveobj.MetaMapType, error) {
	if oref.OType != waveobj.OType_Workspace {
		return meta, nil
	}
	return metaguard.ReadMeta(moltenMetaCaller(ctx, true), oref, meta)
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
