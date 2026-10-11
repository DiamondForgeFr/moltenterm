// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"errors"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
)

type fakeDurable struct {
	jobStatus   string
	statusAfter string
	errs        []error
	starts      []bool
	notices     int
}

func (f *fakeDurable) starter() durableStarter {
	return durableStarter{
		start: func(force bool) error {
			f.starts = append(f.starts, force)
			if len(f.errs) == 0 {
				return nil
			}
			err := f.errs[0]
			f.errs = f.errs[1:]
			return err
		},
		status:    func() string { return f.statusAfter },
		jobStatus: func() string { return f.jobStatus },
		notice:    func() { f.notices++ },
	}
}

func TestStartDurableAtFirstResync(t *testing.T) {
	gone := errors.New("failed to reconnect to job: job manager process is not running")
	cases := []struct {
		name        string
		f           fakeDurable
		wantStarts  []bool
		wantNotices int
		wantErr     bool
	}{
		{"no job yet starts a new shell", fakeDurable{jobStatus: "", statusAfter: Status_Running}, []bool{false}, 0, false},
		{"running session is reattached", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Running, statusAfter: Status_Running}, []bool{false}, 0, false},
		{"ended session is replaced", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Done, statusAfter: Status_Running}, []bool{true}, 1, false},
		{"session that never started is replaced", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Init, statusAfter: Status_Running}, []bool{true}, 1, false},
		{"running session whose manager is gone is replaced", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Running, statusAfter: Status_Done, errs: []error{gone}}, []bool{false, true}, 1, false},
		{"reconnect failing for another reason is reported", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Running, statusAfter: Status_Running, errs: []error{errors.New("connection down")}}, []bool{false}, 0, true},
		{"failed replacement is reported", fakeDurable{jobStatus: jobcontroller.JobManagerStatus_Done, statusAfter: Status_Done, errs: []error{errors.New("spawn failed")}}, []bool{true}, 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := tc.f
			err := startDurableAtFirstResync(f.starter())
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, want error %v", err, tc.wantErr)
			}
			if !reflect.DeepEqual(f.starts, tc.wantStarts) {
				t.Fatalf("starts (force) = %v, want %v", f.starts, tc.wantStarts)
			}
			if f.notices != tc.wantNotices {
				t.Fatalf("notices = %d, want %d", f.notices, tc.wantNotices)
			}
		})
	}
}

func TestFirstResyncIsPerBlockAndRecordedOnSuccess(t *testing.T) {
	const a, b = "first-resync-test-a", "first-resync-test-b"
	if !isFirstResync(a) || !isFirstResync(b) {
		t.Fatalf("a block never resynced in this run must be a first resync")
	}
	markResynced(a)
	if isFirstResync(a) {
		t.Fatalf("a block whose controller started is no longer a first resync")
	}
	if !isFirstResync(b) {
		t.Fatalf("recording one block must not affect another")
	}
}
