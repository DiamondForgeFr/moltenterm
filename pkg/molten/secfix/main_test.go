// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/paralleltest"
)

func serialTest(t *testing.T, why string) {
	t.Helper()
	paralleltest.Serial(t, why)
}

func TestEveryTestChoosesParallelism(t *testing.T) {
	t.Parallel()
	paralleltest.EveryTestChoosesParallelism(t, nil, nil)
}
