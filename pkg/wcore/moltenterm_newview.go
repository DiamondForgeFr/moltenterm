// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// CreateTabWithBlock makes a new tab whose only block is blockDef (FR-SHELL-089): the new view chooser or the type
// the developer chose to open directly. A nil blockDef gives the usual terminal.
func CreateTabWithBlock(ctx context.Context, workspaceId string, blockDef *waveobj.BlockDef, activateTab bool) (string, error) {
	return createTabWithLayout(ctx, workspaceId, "", activateTab, false, newViewLayout(blockDef))
}

func newViewLayout(blockDef *waveobj.BlockDef) PortableLayout {
	if blockDef == nil || len(blockDef.Meta) == 0 {
		return GetNewTabLayout()
	}
	return PortableLayout{{IndexArr: []int{0}, BlockDef: blockDef, Focused: true}}
}
