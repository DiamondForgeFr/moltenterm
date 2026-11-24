// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// NewViewChooserMetaKey marks the launcher block of a new view: it shows the chooser (FR-SHELL-089). The frontend's
// NewViewMetaKey (frontend/moltenterm-shell/newview/new-view-model.ts) holds the same key.
const NewViewChooserMetaKey = "molten:newview"

func newViewChooserBlockDef() *waveobj.BlockDef {
	return &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "launcher", NewViewChooserMetaKey: true}}
}

// replaceLastView keeps the window open when its last view closed (#2517, FR-SHELL-080): Wave closed the window, and
// with it the app, when the last block of the last tab went, whether the panel's close button, `exit` in a shell, an
// agent ending on its own or the view's own close did it. A new view holding the chooser takes its place, as ⌘N
// gives; quitting stays the menu's, ⌘Q's or the window's.
func replaceLastView(ctx context.Context, workspaceId string) (string, error) {
	tabId, err := CreateTabWithBlock(ctx, workspaceId, newViewChooserBlockDef(), true)
	if err != nil {
		return tabId, fmt.Errorf("opening a new view in place of the last one: %w", err)
	}
	return tabId, nil
}
