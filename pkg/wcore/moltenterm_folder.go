// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"log"
	"os"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// contextFolderOf is the folder of the context a workspace is in (#2516), "" when it has none or the client cannot be
// read.
func contextFolderOf(ctx context.Context, workspaceMeta waveobj.MetaMapType) string {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return ""
	}
	return contexts.FolderOf(contexts.ReadContexts(client.Meta), workspaceMeta)
}

// A new block starts in its workspace's folder (FR-SHELL-009). Applied where every block is created, so the add panel,
// shortcuts, wsh and new tabs all get it; the block definition the caller passed is never modified.
func blockDefInWorkspaceFolder(ctx context.Context, tabId string, blockDef *waveobj.BlockDef) *waveobj.BlockDef {
	if blockDef == nil || blockDef.Meta == nil {
		return blockDef
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil || wsId == "" {
		return blockDef
	}
	ws, _ := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if ws == nil {
		return blockDef
	}
	folder := molten.StartFolder(contextFolderOf(ctx, ws.Meta), ws.Meta)
	if folder == "" {
		return blockDef
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		log.Printf("workspace %q folder %q is not a folder, new blocks start as usual\n", wsId, folder)
		return blockDef
	}
	meta, changed := molten.BlockMetaInFolder(blockDef.Meta, folder)
	if !changed {
		return blockDef
	}
	rtn := *blockDef
	rtn.Meta = meta
	return &rtn
}
