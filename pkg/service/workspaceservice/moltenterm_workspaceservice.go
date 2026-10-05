// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/tsgen/tsgenmeta"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The last workspace of a window is reset rather than deleted (#222); Electron asks before showing its delete
// confirmation, so the user is never asked to confirm a delete that would be refused.

func (svc *WorkspaceService) CanCloseWorkspace_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames: []string{"workspaceId"},
	}
}

func (svc *WorkspaceService) CanCloseWorkspace(workspaceId string) (bool, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	err := wcore.CheckWorkspaceClosable(ctx, workspaceId)
	if errors.Is(err, wcore.ErrLastWorkspace) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (svc *WorkspaceService) ResetWorkspace_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"workspaceId"},
		ReturnDesc: "tabId",
	}
}

func (svc *WorkspaceService) ResetWorkspace(workspaceId string) (string, waveobj.UpdatesRtnType, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	ctx = waveobj.ContextWithUpdates(ctx)
	ws, err := wcore.GetWorkspace(ctx, workspaceId)
	if err != nil {
		return "", nil, fmt.Errorf("error getting workspace: %w", err)
	}
	// As CloseTab does: the panes' controllers (shells, agents) stop with their tabs.
	var blockIds []string
	for _, tabId := range ws.TabIds {
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if tab != nil {
			blockIds = append(blockIds, tab.BlockIds...)
		}
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:ResetWorkspace:DestroyBlockControllers", recover())
		}()
		for _, blockId := range blockIds {
			blockcontroller.DestroyBlockController(blockId)
		}
	}()
	newTabId, err := wcore.ResetWorkspace(ctx, workspaceId)
	if err != nil {
		return "", nil, fmt.Errorf("error resetting workspace: %w", err)
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:ResetWorkspace:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
	return newTabId, updates, nil
}
