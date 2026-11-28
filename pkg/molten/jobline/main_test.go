// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package jobline

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

// The table of command lines names gh as a program: no test of this package may reach GitHub.
func TestMain(m *testing.M) {
	os.Exit(ghguard.Main(m))
}
