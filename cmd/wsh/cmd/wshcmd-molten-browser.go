// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
// tab meta; wsh adds the request to the panel's block meta, which the panel reads, opens and clears. No new RPC.

// openInBrowserPanel returns the panel the page was sent to, or "" when the tab has none (the caller creates one).
func openInBrowserPanel(tabId string, url string) (string, error) {
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
	pending := map[string]any{}
	for _, b := range blocks {
		if b.TabId != tabId || b.Meta.GetString(waveobj.MetaKey_View, "") != molten.BrowserView {
			continue
		}
		panels = append(panels, b.BlockId)
		pending[b.BlockId] = b.Meta[molten.BrowserOpenMetaKey]
	}
	if len(panels) == 0 {
		return "", nil
	}
	tabMeta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Tab, tabId)}, nil)
	if err != nil {
		return "", fmt.Errorf("reading the tab's browser history: %w", err)
	}
	target := molten.PickBrowserPanel(panels, tabMeta[molten.BrowserRecentMetaKey])
	requestId, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	err = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, target),
		Meta: waveobj.MetaMapType{
			molten.BrowserOpenMetaKey: molten.AppendBrowserOpenRequest(pending[target], requestId.String(), url),
		},
	}, nil)
	if err != nil {
		return "", fmt.Errorf("opening the page in browser panel %s: %w", target, err)
	}
	return target, nil
}
