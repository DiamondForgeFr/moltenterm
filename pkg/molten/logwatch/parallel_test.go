// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/paralleltest"
)

// Each test of this package says whether it runs in parallel (load-proof tests, #2022).
func TestEveryTestRunsInParallelOrSaysWhy(t *testing.T) {
	t.Parallel()
	paralleltest.EveryTestChoosesParallelism(t, nil, nil)
}

// serialTest marks a test that changes state the others read (wavesrv's channel in buildchannel), with the reason.
func serialTest(t *testing.T, why string) {
	t.Helper()
	paralleltest.Serial(t, why)
}
