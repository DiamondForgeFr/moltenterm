// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package blockcontroller

import (
	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/featuresintest"
)

// The developer's switches of Features in test (FR-BOSS-011) are read from the client's meta at each call of a gated
// feature; registered here, with the other parts wavesrv starts, so the gate packages do not import the database.
func init() {
	buildchannel.UseNarrowing(featuresintest.Live)
}
