// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

func TestMain(m *testing.M) {
	os.Exit(ghguard.Main(m))
}
