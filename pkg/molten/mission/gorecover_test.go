// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"testing"
	"time"
)

// A panic in a goroutine goRecovered started is recovered: the test binary, like wavesrv, lives on (#2125).
func TestGoRecoveredSurvivesAPanic(t *testing.T) {
	t.Parallel()
	ran := make(chan struct{})
	goRecovered("test", func() {
		defer close(ran)
		panic("the work blew up")
	})
	select {
	case <-ran:
	case <-time.After(time.Minute):
		t.Fatal("the goroutine did not run")
	}
}
