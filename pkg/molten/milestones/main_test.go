// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

// The tests read the forge through a fake gh; the guard fails the run if anything reached the real one.
func TestMain(m *testing.M) {
	os.Exit(ghguard.Main(m))
}
