// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// moltenKeptWorktreesNotice reads the terminals linked to worktrees in a workspace about to be deleted (its window
// closed, or the workspace deleted): bulk actions ask nothing, so the returned function, called once the workspace is
// gone, tells in the notification center which worktrees are still on disk (FR-SHELL-016, #134). App quit deletes no
// workspace and stays silent.
func moltenKeptWorktreesNotice(ctx context.Context, workspace *waveobj.Workspace) func() {
	if workspace == nil {
		return func() {}
	}
	blocks := mission.BlocksForKeptWorktreeNotice(ctx, workspace.TabIds)
	if len(blocks) == 0 {
		return func() {}
	}
	return func() {
		go func() {
			defer func() {
				panichandler.PanicHandler("moltenKeptWorktreesNotice", recover())
			}()
			mission.NoticeKeptWorktrees(blocks, "", "")
		}()
	}
}
