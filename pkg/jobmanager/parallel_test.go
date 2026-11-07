// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package jobmanager

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/paralleltest"
)

// The tests of Moltenterm's stall check wait for real streams, and they took a minute when they ran one after the
// other (#2022): a new test that forgets t.Parallel() brings that back. Each one says which it is. The 7 tests of
// streammanager_test.go come from Wave, last 1.5 s in all and are not edited: a changed Wave file goes into the patch
// ledger.
func TestEveryTestRunsInParallelOrSaysWhy(t *testing.T) {
	t.Parallel()
	paralleltest.EveryTestChoosesParallelism(t, []string{"streammanager_test.go"}, nil)
}

func serialTest(t *testing.T, why string) {
	t.Helper()
	paralleltest.Serial(t, why)
}
