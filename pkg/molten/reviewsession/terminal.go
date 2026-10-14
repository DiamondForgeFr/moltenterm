// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// What Restart work (FR-REV-011, pkg/molten/review) reuses of the review sessions: the way they open a terminal in a
// tab and start a command at its first prompt, and the agent the developer reviews with.

var errNotStarted = errors.New("MoltenTerm cannot open terminals yet: try again in a moment")

// OpenTerminal creates a terminal in the tab (split after afterBlockId when it is in the tab, else added), starts its
// shell and types line at its first prompt, with Enter. The block id is returned even when the typing failed.
func OpenTerminal(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType, line string) (string, error) {
	manager := liveManager.Load()
	if manager == nil || manager.env.CreateTerminal == nil || manager.env.StartAndType == nil {
		return "", errNotStarted
	}
	blockId, err := manager.env.CreateTerminal(ctx, tabId, afterBlockId, meta)
	if err != nil {
		return "", err
	}
	return blockId, manager.env.StartAndType(ctx, tabId, blockId, line)
}

// SessionAgent is the agent of the PR's review session, "" when it has none.
func SessionAgent(ctx context.Context, repo string, number int) string {
	manager := liveManager.Load()
	if manager == nil {
		return ""
	}
	info := manager.Get(ctx, mcpreview.SessionKey{Repo: repo, Number: number})
	if info == nil {
		return ""
	}
	return info.Agent
}
