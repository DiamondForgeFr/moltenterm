// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

func TestMain(m *testing.M) {
	os.Exit(ghguard.Main(m))
}
