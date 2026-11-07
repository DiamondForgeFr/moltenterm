// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/paralleltest"
)

// This package's tests took minutes when they ran one after the other, and every Go change waited for them (#2022): a
// new test that forgets t.Parallel() brings that back one test at a time. Each one says which it is.
func TestEveryTestRunsInParallelOrSaysWhy(t *testing.T) {
	t.Parallel()
	paralleltest.EveryTestChoosesParallelism(t, nil, nil)
}
