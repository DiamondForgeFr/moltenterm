// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"sync/atomic"
	"testing"
	"time"
)

// A pass that panics ends that pass only: the loop runs the next one (#2125), as the process links and the global
// usage readings need for the rest of the run.
func TestEveryRecoveredGoesOnAfterAPanickingPass(t *testing.T) {
	var passes atomic.Int32
	again := make(chan struct{})
	stop := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		everyRecovered("test", time.Millisecond, true, stop, func() {
			switch passes.Add(1) {
			case 1:
				panic("the first reading blew up")
			case 2:
				close(again)
			}
		})
	}()
	select {
	case <-again:
	case <-time.After(time.Minute):
		t.Fatalf("the loop stopped after a panicking pass (%d passes)", passes.Load())
	}
	close(stop)
	select {
	case <-exited:
	case <-time.After(time.Minute):
		t.Fatal("the loop did not end on stop")
	}
}
