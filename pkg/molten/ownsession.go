// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Brokk's own session (FR-BOSS-009, AC15 and AC26, #2033) is a terminal in a hidden tab that carries this key in its
// meta, and so does its tab. There is one Brokk on screen: his session never shows as a workspace agent, in the agent
// lists, the sessions, the views, the notifications or the toasts. Only his face shows that he works.
//
// must match frontend/moltenterm-shell/boss/brokk-session.ts
const OwnSessionMetaKey = "molten:brokk"

// IsOwnSession tells whether a block's or a tab's meta marks Brokk's own session.
func IsOwnSession(meta waveobj.MetaMapType) bool {
	return meta[OwnSessionMetaKey] == true
}

// HideLeftOwnTab puts Brokk's tab among the hidden ones again once the developer has left it: he may have been shown it
// on purpose (Open his terminal), but his tab never stays in the views. left is the tab that was active, now the
// workspace shows next; true when the hidden list changed.
func HideLeftOwnTab(ws *waveobj.Workspace, left string, leftMeta waveobj.MetaMapType, next string) bool {
	if ws == nil || left == "" || left == next || !IsOwnSession(leftMeta) || !slices.Contains(ws.TabIds, left) {
		return false
	}
	ids := HiddenTabIds(ws)
	if slices.Contains(ids, left) {
		return false
	}
	SetHiddenTabIds(ws, append(ids, left))
	return true
}
