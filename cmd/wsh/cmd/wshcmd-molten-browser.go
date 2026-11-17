// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// A page wsh opens goes to the browser panel the user last focused in the tab, as a new tab (#140), like the links the
// frontend opens (frontend/moltenterm-shell/browser/browser-routing.ts). The frontend keeps the focus history in the
// tab meta; wsh queues the page in the panel's block meta as a key of its own (setmeta merges keys, so concurrent
// opens never overwrite each other), and the panel opens each entry and removes it. No new RPC.

// openInBrowserPanel returns the panel the page was sent to, or "" when the tab has none (the caller creates one).
func openInBrowserPanel(tabId string, url string) (string, error) {
	return queueInBrowserPanel(tabId, func(id string) waveobj.MetaMapType { return molten.BrowserOpenRequestMeta(id, url) })
}

// openPagesOf lists the pages the browser panels of one Wave tab show, for finding the one that shows an address (#2333):
// a page handed off to an installed browser is not here, it has no page of its own. recent is the tab meta
// molten.BrowserRecentMetaKey.
func openPagesOf(tabId string, blocks []wshrpc.BlocksListEntry, recent any) []molten.OpenPage {
	recentIds, _ := recent.([]any)
	var rtn []molten.OpenPage
	order := 0
	for _, b := range blocks {
		if b.TabId != tabId || b.Meta.GetString(waveobj.MetaKey_View, "") != molten.BrowserView {
			continue
		}
		order++
		rank := -1
		for i, raw := range recentIds {
			if id, _ := raw.(string); id == b.BlockId {
				rank = i
				break
			}
		}
		active := b.Meta.GetString(molten.BrowserActiveMetaKey, "")
		for i, tab := range molten.BrowserPanelTabs(b.Meta) {
			if tab.Engine != "" {
				continue
			}
			rtn = append(rtn, molten.OpenPage{
				PanelId: b.BlockId,
				TabId:   tab.Id,
				Url:     tab.Url,
				InView:  tab.Id == active,
				Recent:  rank,
				Seq:     int64(order)*1000 + int64(i),
			})
		}
	}
	return rtn
}

// showOpenPage brings into view the page of this terminal's Wave tab that already shows url, instead of opening it
// again (#2333); it returns the panel, or "" when no page of the tab shows it. It shows the page and hands nothing to
// anyone: the panel selects the tab and scrolls into view, as it does for a page an agent shows.
func showOpenPage(tabId string, url string) (string, error) {
	if RpcContext.BlockId == "" {
		return "", nil
	}
	self, err := wshclient.BlockInfoCommand(RpcClient, RpcContext.BlockId, nil)
	if err != nil {
		return "", fmt.Errorf("getting this block's workspace: %w", err)
	}
	blocks, err := wshclient.BlocksListCommand(RpcClient, wshrpc.BlocksListRequest{WorkspaceId: self.WorkspaceId}, nil)
	if err != nil {
		return "", fmt.Errorf("listing the tab's blocks: %w", err)
	}
	tabMeta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Tab, tabId)}, nil)
	if err != nil {
		return "", fmt.Errorf("reading the tab's browser history: %w", err)
	}
	page, ok := molten.BestOpenPage(openPagesOf(tabId, blocks, tabMeta[molten.BrowserRecentMetaKey]), url)
	if !ok {
		return "", nil
	}
	requestId, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	err = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, page.PanelId),
		Meta: molten.BrowserShowRequestMeta(requestId.String(), page.TabId),
	}, nil)
	if err != nil {
		return "", fmt.Errorf("showing the page in browser panel %s: %w", page.PanelId, err)
	}
	return page.PanelId, nil
}

// queueInBrowserPanel writes the request meta (a page, or a handed-off entry) into the panel the user last focused in
// the tab; "" when the tab has no browser panel.
func queueInBrowserPanel(tabId string, requestMeta func(id string) waveobj.MetaMapType) (string, error) {
	if RpcContext.BlockId == "" {
		return "", nil
	}
	self, err := wshclient.BlockInfoCommand(RpcClient, RpcContext.BlockId, nil)
	if err != nil {
		return "", fmt.Errorf("getting this block's workspace: %w", err)
	}
	blocks, err := wshclient.BlocksListCommand(RpcClient, wshrpc.BlocksListRequest{WorkspaceId: self.WorkspaceId}, nil)
	if err != nil {
		return "", fmt.Errorf("listing the tab's blocks: %w", err)
	}
	var panels []string
	for _, b := range blocks {
		if b.TabId != tabId || b.Meta.GetString(waveobj.MetaKey_View, "") != molten.BrowserView {
			continue
		}
		panels = append(panels, b.BlockId)
	}
	if len(panels) == 0 {
		return "", nil
	}
	tabMeta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Tab, tabId)}, nil)
	if err != nil {
		return "", fmt.Errorf("reading the tab's browser history: %w", err)
	}
	target := molten.PickBrowserPanel(panels, tabMeta[molten.BrowserRecentMetaKey])
	requestId, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	err = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, target),
		Meta: requestMeta(requestId.String()),
	}, nil)
	if err != nil {
		return "", fmt.Errorf("opening the page in browser panel %s: %w", target, err)
	}
	return target, nil
}
