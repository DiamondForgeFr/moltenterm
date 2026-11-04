// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// The Project tab opens Pilotage by mission's copy of the view name (#1177): both must name the same view.
func TestPilotageViewMatchesReviewsView(t *testing.T) {
	if mission.PilotageView != ReviewsViewName {
		t.Errorf("mission.PilotageView %q, ReviewsViewName %q", mission.PilotageView, ReviewsViewName)
	}
}
