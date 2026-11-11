// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package blockcontroller

import (
	"github.com/wavetermdev/waveterm/pkg/molten/brainstorm"
	"github.com/wavetermdev/waveterm/pkg/molten/brokksession"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// Brokk's own terminal session (FR-BOSS-009, AC15) starts with Mission Control, like the review sessions: it opens
// terminals through them, so Mission Control cannot import it. The brainstorm mode of his thought in 3D (FR-BOSS-010)
// starts with it.
func init() {
	mission.UseStarter(brokksession.Start)
	mission.UseStarter(brainstorm.Start)
}
