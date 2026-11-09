// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// A follow step that panics ends that step only: the follow reads the agent again at the next tick (#2125).
func TestAgentFollowGoesOnAfterAPanickingStep(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	ended := make(chan struct{})
	r := &Restarter{env: RestartEnv{
		FollowEvery: time.Millisecond,
		Now:         time.Now,
		BlockExists: func(ctx context.Context, blockId string) bool {
			if calls.Add(1) == 1 {
				panic("reading the block blew up")
			}
			close(ended)
			return false
		},
	}}
	r.startFollow(agentFollow{blockId: "b1"})
	select {
	case <-ended:
	case <-time.After(time.Minute):
		t.Fatalf("the follow stopped after a panicking step (%d reads)", calls.Load())
	}
}

func TestRecoverStepKeepsTheLoopGoing(t *testing.T) {
	t.Parallel()
	if !recoverStep("test", func() bool { panic("boom") }) {
		t.Error("a panicking step keeps the loop going")
	}
	if recoverStep("test", func() bool { return false }) {
		t.Error("a step that ends the loop still ends it")
	}
}
