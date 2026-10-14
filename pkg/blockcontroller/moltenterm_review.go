// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// The review sessions (FR-REV-004) start with Mission Control, like the durable sessions: wavesrv starts the shell of
// a session's terminal itself, so the agent starts even before a window shows the Review tab.
func init() {
	mission.UseStarter(func() {
		reviewsession.Start(reviewsession.Hooks{StartTerminal: startReviewTerminal})
	})
}

func startReviewTerminal(ctx context.Context, tabId string, blockId string) error {
	return ResyncController(ctx, tabId, blockId, nil, false)
}
