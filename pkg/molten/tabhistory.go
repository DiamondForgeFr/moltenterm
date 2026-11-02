// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Tab history (#1345, FR-SHELL-108): the views a workspace showed before the current one, the latest first. Closing the
// view on screen goes back to the one shown before it, as a browser does, instead of landing on the view next to it. The
// ids live in the workspace's meta.

const TabHistoryMetaKey = "molten:tabhistory"

// The history keeps this many views: enough to close a long run of them one after the other.
const TabHistoryMax = 20

// TabHistory lists the views shown before the current one that are still among the workspace's tabs, the latest first.
func TabHistory(ws *waveobj.Workspace) []string {
	if ws == nil {
		return nil
	}
	var rtn []string
	switch ids := ws.Meta[TabHistoryMetaKey].(type) {
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

// RememberActiveTab records that the workspace leaves its active tab for next (the caller saves the workspace).
func RememberActiveTab(ws *waveobj.Workspace, next string) {
	prev := ws.ActiveTabId
	if prev == "" || prev == next || !slices.Contains(ws.TabIds, prev) {
		return
	}
	history := slices.DeleteFunc(TabHistory(ws), func(id string) bool { return id == prev || id == next })
	history = append([]string{prev}, history...)
	if len(history) > TabHistoryMax {
		history = history[:TabHistoryMax]
	}
	if ws.Meta == nil {
		ws.Meta = waveobj.MetaMapType{}
	}
	ws.Meta[TabHistoryMetaKey] = history
}

// PreviousShownTab is the latest view of the history that is a tab of the workspace and not a hidden one; "" otherwise.
func PreviousShownTab(ws *waveobj.Workspace, hidden []string) string {
	for _, id := range TabHistory(ws) {
		if !slices.Contains(hidden, id) {
			return id
		}
	}
	return ""
}
