// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// CloseTerminal closes a terminal for Clean branches' "Close the session and clean" (#932, mission.TerminalCloser):
// its durable job ends first, so the agent stops before the worktree is read again, then the block leaves its tab as
// a closed pane does. It goes without the "worktree kept" notice of a close no window asked for: the user asked, and
// the worktree goes right after.
func CloseTerminal(ctx context.Context, blockId string) error {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("reading the terminal: %w", err)
	}
	if block == nil {
		return nil
	}
	if block.JobId != "" {
		jobcontroller.TerminateAndDetachJob(ctx, block.JobId)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return fmt.Errorf("finding the terminal's tab: %w", err)
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	if err := wcore.DeleteBlock(ctx, blockId, true); err != nil {
		return fmt.Errorf("closing the terminal: %w", err)
	}
	if tabId != "" {
		wcore.QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{
			ActionType: wcore.LayoutActionDataType_Remove,
			BlockId:    blockId,
		})
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return nil
}
