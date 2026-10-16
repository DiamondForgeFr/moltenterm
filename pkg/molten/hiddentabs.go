// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Hidden tabs (#758): an agent the developer let work out of sight runs in a tab of the workspace that the tab bars do
// not show. The tab stays in the workspace's tab list, so the agent states, the notifications and the Sessions view find
// it; activating it (Go to, a notification's action, Show) reveals it. The ids live in the workspace's meta.

// must match frontend/moltenterm-shell/hidden-tabs.ts
const HiddenTabsMetaKey = "molten:hiddentabs"

// HiddenTabIds lists the workspace's hidden tabs that are still among its tabs.
func HiddenTabIds(ws *waveobj.Workspace) []string {
	if ws == nil {
		return nil
	}
	var rtn []string
	switch ids := ws.Meta[HiddenTabsMetaKey].(type) {
	case []string:
		rtn = append(rtn, ids...)
	case []any:
		for _, id := range ids {
			if s, ok := id.(string); ok && s != "" {
				rtn = append(rtn, s)
			}
		}
	}
	return slices.DeleteFunc(rtn, func(id string) bool { return !slices.Contains(ws.TabIds, id) })
}

func IsHiddenTab(ws *waveobj.Workspace, tabId string) bool {
	return tabId != "" && slices.Contains(HiddenTabIds(ws), tabId)
}

// SetHiddenTabIds writes the list in the workspace's meta (the caller saves the workspace).
func SetHiddenTabIds(ws *waveobj.Workspace, ids []string) {
	if ws.Meta == nil {
		ws.Meta = waveobj.MetaMapType{}
	}
	if len(ids) == 0 {
		delete(ws.Meta, HiddenTabsMetaKey)
		return
	}
	ws.Meta[HiddenTabsMetaKey] = ids
}

// RevealTab takes the tab out of the hidden ones; true when it was hidden.
func RevealTab(ws *waveobj.Workspace, tabId string) bool {
	ids := HiddenTabIds(ws)
	if !slices.Contains(ids, tabId) {
		return false
	}
	SetHiddenTabIds(ws, slices.DeleteFunc(ids, func(id string) bool { return id == tabId }))
	return true
}

// KeepHiddenTabs is the tab list a window sends (a drag in the tab bar, which shows no hidden tab) with the hidden tabs
// it did not send put back at the end, so reordering never drops them.
func KeepHiddenTabs(ws *waveobj.Workspace, tabIds []string) []string {
	rtn := slices.Clone(tabIds)
	for _, id := range HiddenTabIds(ws) {
		if !slices.Contains(rtn, id) {
			rtn = append(rtn, id)
		}
	}
	return rtn
}

// VisibleNeighbour is the tab a window shows once the active tab at index idx of tabIds (already removed) is gone: the
// nearest shown tab on its left, else on its right; "" when only hidden tabs remain.
func VisibleNeighbour(tabIds []string, hidden []string, idx int) string {
	for i := min(idx-1, len(tabIds)-1); i >= 0; i-- {
		if !slices.Contains(hidden, tabIds[i]) {
			return tabIds[i]
		}
	}
	for i := max(idx, 0); i < len(tabIds); i++ {
		if !slices.Contains(hidden, tabIds[i]) {
			return tabIds[i]
		}
	}
	return ""
}
