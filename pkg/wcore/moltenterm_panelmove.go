// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/panelmove"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MoveTabMainPanel moves the main panel of one tab into another tab of the same workspace (drag to split,
// FR-SHELL-060). The block itself moves (its controller, shell and files stay), so nothing restarts. The window that
// asked lays it out in its tab; the tab it left drops its node through a layout action that keeps the block.
func MoveTabMainPanel(ctx context.Context, req panelmove.MoveRequest) (panelmove.MoveResult, error) {
	if err := panelmove.CheckRequest(req); err != nil {
		return panelmove.MoveResult{}, err
	}
	fromWs, err := wstore.DBFindWorkspaceForTabId(ctx, req.FromTabId)
	if err != nil {
		return panelmove.MoveResult{}, fmt.Errorf("the dragged tab is in no workspace: %w", err)
	}
	toWs, err := wstore.DBFindWorkspaceForTabId(ctx, req.ToTabId)
	if err != nil {
		return panelmove.MoveResult{}, fmt.Errorf("the tab shown is in no workspace: %w", err)
	}
	if fromWs == "" || fromWs != toWs {
		return panelmove.MoveResult{}, fmt.Errorf("panels move between tabs of one workspace only")
	}
	rtn, err := wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (panelmove.MoveResult, error) {
		txCtx := tx.Context()
		from, err := wstore.DBMustGet[*waveobj.Tab](txCtx, req.FromTabId)
		if err != nil {
			return panelmove.MoveResult{}, err
		}
		to, err := wstore.DBMustGet[*waveobj.Tab](txCtx, req.ToTabId)
		if err != nil {
			return panelmove.MoveResult{}, err
		}
		layout, _ := wstore.DBGet[*waveobj.LayoutState](txCtx, from.LayoutState)
		blockId := panelmove.MainBlockId(layout, from.BlockIds)
		if blockId == "" {
			return panelmove.MoveResult{}, fmt.Errorf("the dragged tab has no panel")
		}
		block, err := wstore.DBMustGet[*waveobj.Block](txCtx, blockId)
		if err != nil {
			return panelmove.MoveResult{}, err
		}
		from.BlockIds = utilfn.RemoveElemFromSlice(from.BlockIds, blockId)
		to.BlockIds = append(to.BlockIds, blockId)
		block.ParentORef = waveobj.MakeORef(waveobj.OType_Tab, to.OID).String()
		if err := wstore.DBUpdate(txCtx, from); err != nil {
			return panelmove.MoveResult{}, err
		}
		if err := wstore.DBUpdate(txCtx, to); err != nil {
			return panelmove.MoveResult{}, err
		}
		if err := wstore.DBUpdate(txCtx, block); err != nil {
			return panelmove.MoveResult{}, err
		}
		return panelmove.MoveResult{BlockId: blockId, SourceEmpty: len(from.BlockIds) == 0, WorkspaceId: fromWs}, nil
	})
	if err != nil {
		return panelmove.MoveResult{}, err
	}
	// A tab left empty is closed by the window (Wave's own close); one that keeps panels drops the moved node.
	if !rtn.SourceEmpty {
		detach := waveobj.LayoutActionData{ActionType: panelmove.LayoutActionDetach, BlockId: rtn.BlockId}
		if err := QueueLayoutActionForTab(ctx, req.FromTabId, detach); err != nil {
			return rtn, fmt.Errorf("the panel moved but its old tab was not told: %w", err)
		}
	}
	from, _ := wstore.DBGet[*waveobj.Tab](ctx, req.FromTabId)
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, rtn.BlockId))
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, req.FromTabId))
	SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, req.ToTabId))
	if from != nil {
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_LayoutState, from.LayoutState))
	}
	return rtn, nil
}

// StartPanelMoveRoute lets the windows move a tab's panel into the tab they show; wavesrv calls it once.
func StartPanelMoveRoute() {
	panelmove.StartRoute(MoveTabMainPanel)
}
