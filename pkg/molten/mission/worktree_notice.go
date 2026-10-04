// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A terminal linked to a worktree can go without a window asking (FR-SHELL-016, #134): its shell exits with
// cmd:closeonexit, a command deletes or replaces it (wsh deleteblock, wsh web open --replace), or its window or
// workspace is closed (bulk actions: no modal, quitting stays fast). Nothing is removed then: the notification center
// says the worktree is still on disk, with an action that opens the plan dialog. One worktree is one notification,
// whatever path its terminals were linked by: paths are compared with symlinks resolved.

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
		Key:    KeptWorktreeNoticeKey(path),
		Source: "moltenterm",
		Kind:   "info",
		Title:  fmt.Sprintf("Worktree %s is still on disk", filepath.Base(path)),
		Message: fmt.Sprintf("Its terminal closed without MoltenTerm asking (its shell exited, a command closed it, or its "+
			"window or workspace closed); the worktree and its branch are kept.\n%s", path),
		WorkspaceId: workspaceId,
		TabId:       tabId,
		Actions:     []molten.NotificationAction{review},
	}
}

// keptWorktreeLink is the worktree a deleted block leaves behind: a local terminal's link, with symlinks resolved,
// when the worktree is still there. "" otherwise.
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
	return realPath(link)
}

// keptWorktrees: the worktrees the deleted blocks leave behind, one per canonical path, in the blocks' order.
func keptWorktrees(blocks []*waveobj.Block) []string {
	var rtn []string
	for _, block := range blocks {
		if link := keptWorktreeLink(block); link != "" && !slices.Contains(rtn, link) {
			rtn = append(rtn, link)
		}
	}
	return rtn
}

// NoticeKeptWorktrees runs once wavesrv deleted blocks no window asked about. A worktree another open terminal is
// still linked to gets no notice: closing that terminal asks.
func NoticeKeptWorktrees(blocks []*waveobj.Block, tabId string, workspaceId string) {
	links := keptWorktrees(blocks)
	if len(links) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), keptNoticeTimeout)
	defer cancel()
	var deleted []string
	for _, block := range blocks {
		deleted = append(deleted, block.OID)
	}
	// The last block of a tab takes the tab with it; a deleted workspace takes everything.
	if tabId != "" {
		if tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId); err != nil || tab == nil {
			tabId = ""
		}
	}
	if workspaceId != "" {
		if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId); err != nil || ws == nil {
			workspaceId, tabId = "", ""
		}
	}
	for _, link := range links {
		if slices.ContainsFunc(openWorktreeTerminals(ctx, link, deleted), func(t WorktreeTerminal) bool { return t.Linked }) {
			continue
		}
		if err := attention.PublishNotification(ctx, keptWorktreeNotice(link, workspaceId, tabId)); err != nil {
			log.Printf("molten: telling the worktree %s is kept: %v\n", link, err)
		}
	}
}

// NoticeKeptWorktree: NoticeKeptWorktrees for one block.
func NoticeKeptWorktree(block *waveobj.Block, tabId string, workspaceId string) {
	NoticeKeptWorktrees([]*waveobj.Block{block}, tabId, workspaceId)
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

// BlocksForKeptWorktreeNotice reads the linked terminals of a workspace about to be deleted (its window closed, or
// the workspace deleted).
func BlocksForKeptWorktreeNotice(ctx context.Context, tabIds []string) []*waveobj.Block {
	var rtn []*waveobj.Block
	for _, tabId := range tabIds {
		tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if err != nil || tab == nil {
			continue
		}
		for _, blockId := range tab.BlockIds {
			if block, err := wstore.DBGet[*waveobj.Block](ctx, blockId); err == nil && keptWorktreeLink(block) != "" {
				rtn = append(rtn, block)
			}
		}
	}
	return rtn
}
