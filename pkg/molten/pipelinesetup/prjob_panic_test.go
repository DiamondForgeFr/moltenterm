// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"context"
	"strings"
	"testing"
)

// A pull request job whose work panics ends as failed (#2125): wavesrv lives on and the project can prepare again.
func TestPanickingPrJobEndsFailed(t *testing.T) {
	t.Parallel()
	s := &Setup{}
	dir := t.TempDir()
	job, err := s.startJob(&PrJob{Dir: dir, Kind: "release"}, []string{"write"}, func(ctx context.Context, job *PrJob) error {
		s.stepState(job, "write", PrStateRunning, "")
		panic("the work blew up")
	})
	if err != nil {
		t.Fatal(err)
	}
	done := waitJob(t, s, job)
	if done.Failure == nil || !strings.Contains(done.Failure.Output, "the work blew up") || done.Steps[0].State != PrStateFailed {
		t.Fatalf("a panicking job ends failed: %+v", done)
	}
	again, err := s.startJob(&PrJob{Dir: dir, Kind: "release"}, []string{"write"}, func(ctx context.Context, job *PrJob) error {
		return nil
	})
	if err != nil {
		t.Fatalf("the project can prepare again after a panic: %v", err)
	}
	waitJob(t, s, again)
}
