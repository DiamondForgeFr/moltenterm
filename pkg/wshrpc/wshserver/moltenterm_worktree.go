// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// moltenKeptWorktreeNotice reads a block about to be deleted without a window asking (cmd:closeonexit, wsh
// deleteblock, a block replaced by wsh): the returned function, called once it is deleted, tells in the notification
// center that its worktree is still on disk (FR-SHELL-016, #134).
func moltenKeptWorktreeNotice(ctx context.Context, blockId string, tabId string) func() {
	block, workspaceId := mission.BlockForKeptWorktreeNotice(ctx, blockId, tabId)
	if block == nil {
		return func() {}
	}
	return func() {
		go func() {
			defer func() {
				panichandler.PanicHandler("moltenKeptWorktreeNotice", recover())
			}()
			mission.NoticeKeptWorktree(block, tabId, workspaceId)
		}()
	}
}
