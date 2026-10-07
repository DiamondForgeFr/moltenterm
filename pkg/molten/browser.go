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
	// must match BrowserTabsMetaKey, BrowserActiveMetaKey, BrowserOpenKeyPrefix and BrowserRecentMetaKey in
	// frontend/moltenterm-shell/browser/browser-model.ts
	BrowserTabsMetaKey   = "molten:browser:tabs"
	BrowserActiveMetaKey = "molten:browser:active"
	// block meta: the queue of pages to open in the panel as new tabs, one key per page (prefix + time-ordered id =
	// url), so concurrent writers merge instead of overwriting a shared list; the panel removes what it opened (#140)
	BrowserOpenKeyPrefix = "molten:browser:open:"
	// tab meta: the tab's browser panels, most recently focused first, written by the frontend (#140)
	BrowserRecentMetaKey = "molten:browser:recent"
	// block meta: the panel was created for a link whose site may have no engine yet; its first tab asks (FR-BRW-006).
	// Must match BrowserAskMetaKey in frontend/moltenterm-shell/browser/browser-model.ts.
	BrowserAskMetaKey = "molten:browser:ask"
	// block meta: the panel was created for a page from BROWSER; it leaves the focus in the terminal (FR-BRW-007).
	// Must match BrowserKeepFocusMetaKey in frontend/moltenterm-shell/browser/browser-model.ts.
	BrowserKeepFocusMetaKey = "molten:browser:keepfocus"
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

// BrowserOpenRequestMeta returns the block meta update that queues url in a browser panel. id must be time-ordered
// (UUID v7): the panel opens the queue in id order.
func BrowserOpenRequestMeta(id string, url string) waveobj.MetaMapType {
	return waveobj.MetaMapType{BrowserOpenKeyPrefix + id: url}
}

// BrowserHandoffRequestMeta returns the block meta update that adds a handed-off entry to a browser panel (FR-BRW-002):
// a page already opened in the installed browser engine (a browser id), kept in the tab strip. The panel reads an
// object instead of the plain url of BrowserOpenRequestMeta.
func BrowserHandoffRequestMeta(id string, url string, engine string) waveobj.MetaMapType {
	return waveobj.MetaMapType{BrowserOpenKeyPrefix + id: map[string]any{"url": url, "engine": engine}}
}

// BrowserEnvRequestMeta returns the block meta update that queues a page a terminal program opened through BROWSER
// (FR-BRW-007): the panel leaves the keyboard focus in the terminal the program runs in and, with ask, asks which
// engine the site uses when nothing is decided yet (DS-BRW-022). A page an installed browser sent back had an engine
// already: it never asks.
func BrowserEnvRequestMeta(id string, url string, ask bool) waveobj.MetaMapType {
	entry := map[string]any{"url": url, "keepfocus": true}
	if ask {
		entry["ask"] = true
	}
	return waveobj.MetaMapType{BrowserOpenKeyPrefix + id: entry}
}

// BrowserEnvBlockMeta is the meta of a browser panel created for a page a terminal program opened through BROWSER,
// when the tab has none: with ask, its first tab asks like a queued page does (BrowserEnvRequestMeta).
func BrowserEnvBlockMeta(url string, ask bool) waveobj.MetaMapType {
	meta := waveobj.MetaMapType{waveobj.MetaKey_View: BrowserView, waveobj.MetaKey_Url: url}
	if ask {
		meta[BrowserAskMetaKey] = true
		meta[BrowserKeepFocusMetaKey] = true
	}
	return meta
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
