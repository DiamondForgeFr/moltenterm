// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A terminal linked to a worktree can go without a window asking (FR-SHELL-016, #134): its shell exits with
// cmd:closeonexit, or a command deletes or replaces it (wsh deleteblock, wsh web open --replace). Nothing is removed
// then: the notification center says the worktree is still on disk, with an action that opens the plan dialog.

const (
	// must match frontend/moltenterm-shell/worktree-model.ts
	KeptWorktreeNoticePrefix = "worktree:kept:"
	WorktreeReviewGesture    = "worktree:review"

	keptNoticeTimeout = 10 * time.Second
)

func KeptWorktreeNoticeKey(path string) string {
	return KeptWorktreeNoticePrefix + path
}

func keptWorktreeNotice(path string, workspaceId string, tabId string) molten.NotificationInput {
	review := molten.NotificationAction{Id: "review", Label: "Review and remove…", Kind: "gesture",
		Gesture: WorktreeReviewGesture, Args: map[string]any{"path": path}}
	return molten.NotificationInput{
		Key:         KeptWorktreeNoticeKey(path),
		Source:      "moltenterm",
		Kind:        "info",
		Title:       fmt.Sprintf("Worktree %s is still on disk", filepath.Base(path)),
		Message:     fmt.Sprintf("Its terminal closed on its own (its shell exited, or a command closed it); the worktree and its branch are kept.\n%s", path),
		WorkspaceId: workspaceId,
		TabId:       tabId,
		Actions:     []molten.NotificationAction{review},
	}
}

// keptWorktreeLink is the worktree a deleted block leaves behind: a local terminal's link, when the worktree is still
// there. "" otherwise.
func keptWorktreeLink(block *waveobj.Block) string {
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
		return ""
	}
	conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	if conn != "" && conn != "local" {
		return ""
	}
	link := block.Meta.GetString(molten.WorktreeMetaKey, "")
	if link == "" || !filepath.IsAbs(link) || molten.WorktreeMissing(link) {
		return ""
	}
	return filepath.Clean(link)
}

// NoticeKeptWorktree runs once wavesrv deleted a block no window asked about. A worktree another terminal is still
// linked to gets no notice: closing that terminal asks.
func NoticeKeptWorktree(block *waveobj.Block, tabId string, workspaceId string) {
	link := keptWorktreeLink(block)
	if link == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), keptNoticeTimeout)
	defer cancel()
	for _, term := range openWorktreeTerminals(ctx, link, []string{block.OID}) {
		if term.Linked {
			return
		}
	}
	// The last block of a tab takes the tab with it.
	if tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId); err != nil || tab == nil {
		tabId = ""
	}
	if err := attention.PublishNotification(ctx, keptWorktreeNotice(link, workspaceId, tabId)); err != nil {
		log.Printf("molten: telling the worktree %s is kept: %v\n", link, err)
	}
}

// BlockForKeptWorktreeNotice reads what NoticeKeptWorktree needs before the block is deleted.
func BlockForKeptWorktreeNotice(ctx context.Context, blockId string, tabId string) (*waveobj.Block, string) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || keptWorktreeLink(block) == "" {
		return nil, ""
	}
	workspaceId, _ := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	return block, workspaceId
}
