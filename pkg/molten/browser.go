// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Every web page Moltenterm opens uses its browser panel (FR-SHELL-007): tabs, Cmd+T. Wave's one-page web view stays
// registered for blocks explicitly set to it, but nothing creates one any more, and saved ones are migrated.

const (
	// must match MoltentermBrowserView in frontend/moltenterm-shell/browser/browser-view.tsx
	BrowserView = "molten-browser"
	// Wave's legacy web view, without tabs
	LegacyWebView = "web"
	// must match BrowserTabsMetaKey, BrowserActiveMetaKey, BrowserOpenMetaKey and BrowserRecentMetaKey in
	// frontend/moltenterm-shell/browser/browser-model.ts
	BrowserTabsMetaKey   = "molten:browser:tabs"
	BrowserActiveMetaKey = "molten:browser:active"
	// block meta: pages asked to open in the panel as new tabs, [{id, url}], read and cleared by the panel (#140)
	BrowserOpenMetaKey = "molten:browser:open"
	// tab meta: the tab's browser panels, most recently focused first, written by the frontend (#140)
	BrowserRecentMetaKey = "molten:browser:recent"
)

// PickBrowserPanel returns the browser panel a link opened inside Moltenterm goes to (#140): the most recently
// focused one of the tab that still exists, else the tab's last one (never focused since a restart), else "" (a new
// panel). browserBlockIds are the tab's browser panels in layout order; recent is the tab meta BrowserRecentMetaKey.
// Must match pickBrowserPanel in frontend/moltenterm-shell/browser/browser-model.ts.
func PickBrowserPanel(browserBlockIds []string, recent any) string {
	if len(browserBlockIds) == 0 {
		return ""
	}
	recentIds, _ := recent.([]any)
	for _, raw := range recentIds {
		id, _ := raw.(string)
		if id != "" && slices.Contains(browserBlockIds, id) {
			return id
		}
	}
	return browserBlockIds[len(browserBlockIds)-1]
}

// AppendBrowserOpenRequest returns the block meta value BrowserOpenMetaKey with a request to open url added to the
// ones the panel has not read yet.
func AppendBrowserOpenRequest(pending any, id string, url string) []any {
	rtn := []any{}
	if list, ok := pending.([]any); ok {
		rtn = append(rtn, list...)
	}
	return append(rtn, map[string]any{"id": id, "url": url})
}

// BrowserBlockMeta returns the meta of a block opened in the browser panel instead of Wave's web view, and whether it
// differs from blockMeta (which is never modified). The panel opens meta "url" as its single tab when it has no saved
// tabs, so every other key is kept as is.
func BrowserBlockMeta(blockMeta waveobj.MetaMapType) (waveobj.MetaMapType, bool) {
	if blockMeta == nil || blockMeta.GetString(waveobj.MetaKey_View, "") != LegacyWebView {
		return blockMeta, false
	}
	rtn := make(waveobj.MetaMapType, len(blockMeta))
	for k, v := range blockMeta {
		rtn[k] = v
	}
	rtn[waveobj.MetaKey_View] = BrowserView
	return rtn, true
}

// BrowserPageURL returns the URL of the page a browser panel shows: its active tab, or meta "url" while the panel has
// not saved its tabs yet (as the panel itself reads them).
func BrowserPageURL(blockMeta waveobj.MetaMapType) string {
	tabs, _ := blockMeta[BrowserTabsMetaKey].([]any)
	activeId := blockMeta.GetString(BrowserActiveMetaKey, "")
	firstURL := ""
	for _, raw := range tabs {
		tab, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := tab["id"].(string)
		url, ok := tab["url"].(string)
		if !ok || id == "" {
			continue
		}
		if id == activeId {
			return url
		}
		if firstURL == "" {
			firstURL = url
		}
	}
	if firstURL != "" {
		return firstURL
	}
	return blockMeta.GetString(waveobj.MetaKey_Url, "")
}
