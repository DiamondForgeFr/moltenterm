// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
	"github.com/wavetermdev/waveterm/pkg/molten/paralleltest"
)

func TestMain(m *testing.M) {
	os.Exit(ghguard.Wrap(func() int {
		// Nothing of the developer's git configuration (signing, hooks, aliases) may change what the setup does. Set
		// once for the process: a fixture that set it itself with t.Setenv would keep its test from running in parallel.
		return paralleltest.RunWithGit("Setup test", "setup@example.invalid", m.Run)
	}))
}

// The tests of this package run in parallel (#2022): a test calls t.Parallel() first, unless it changes state that the
// others read (the environment, a package-level variable) or reads state that they disturb, and then it calls
// serialTest with the reason. Go runs the parallel tests together once every serial one is over.
func serialTest(t *testing.T, why string) {
	t.Helper()
	paralleltest.Serial(t, why)
}
