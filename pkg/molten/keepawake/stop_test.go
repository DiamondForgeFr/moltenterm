// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The menu's rows (#1780): what an attempt tells of its end, and the Stop on a terminal's row.

type stopEnv struct {
	*fakeEnv
	names      map[int32]string
	terminated []int32
	failPid    int32
}

func makeStopEnv() *stopEnv {
	return &stopEnv{fakeEnv: makeFakeEnv(), names: map[int32]string{}}
}

func (s *stopEnv) keeper() *Keeper {
	k := s.fakeEnv.keeper()
	k.env.ProcessName = func(pid int32) string { return s.names[pid] }
	k.env.Terminate = func(pid int32) error {
		if pid == s.failPid {
			return errors.New("not permitted")
		}
		s.terminated = append(s.terminated, pid)
		return nil
	}
	return k
}

func shim(t *testing.T, k *Keeper, blockId string, tool string, pid int32, args ...string) {
	t.Helper()
	if _, err := k.Shim(context.Background(), ShimRequest{BlockId: blockId, Tool: tool, Args: args, Pid: pid}); err != nil {
		t.Fatal(err)
	}
}

func TestAttemptLimits(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	cases := []struct {
		tool      string
		args      []string
		endsAt    int64
		stoppable bool
	}{
		{ToolCaffeinate, []string{"-i", "-t", "600"}, now.Add(600 * time.Second).UnixMilli(), true},
		{ToolCaffeinate, []string{"-it600"}, now.Add(600 * time.Second).UnixMilli(), true},
		{ToolCaffeinate, []string{"-d"}, 0, true},
		{ToolCaffeinate, []string{"-w", "123"}, 0, true},
		{ToolCaffeinate, []string{"-i", "make", "build"}, 0, false},
		{ToolCaffeinate, []string{"-t", "60", "--", "make"}, 0, false},
		{ToolCaffeinate, []string{"-x"}, 0, false},
		{ToolSystemdInhibit, []string{"--what=sleep", "sleep", "60"}, 0, false},
	}
	for _, c := range cases {
		endsAt, stoppable := attemptLimits(c.tool, c.args, now)
		if endsAt != c.endsAt || stoppable != c.stoppable {
			t.Errorf("%s %v: got (%d, %v), want (%d, %v)", c.tool, c.args, endsAt, stoppable, c.endsAt, c.stoppable)
		}
	}
}

func TestShimRecordsWhenTheAttemptEnds(t *testing.T) {
	s := makeStopEnv()
	s.policy = PolicyAllow
	k := s.keeper()
	shim(t, k, "b1", ToolCaffeinate, 11, "-i", "-t", "600")
	shim(t, k, "b2", ToolCaffeinate, 12, "-i", "npm", "test")
	state := k.State()
	if len(state.Attempts) != 2 {
		t.Fatalf("attempts: %+v", state.Attempts)
	}
	if a := state.Attempts[0]; !a.Stoppable || a.EndsAt != s.now.Add(600*time.Second).UnixMilli() {
		t.Fatalf("bare caffeinate: %+v", a)
	}
	if a := state.Attempts[1]; a.Stoppable || a.EndsAt != 0 {
		t.Fatalf("wrapped command: %+v", a)
	}
}

func TestStopBlockEndsOnlyItsBareKeepAwake(t *testing.T) {
	s := makeStopEnv()
	s.policy = PolicyAllow
	k := s.keeper()
	shim(t, k, "b1", ToolCaffeinate, 11, "-i", "-t", "600")
	shim(t, k, "b1", ToolCaffeinate, 12, "-i", "make")
	shim(t, k, "b2", ToolCaffeinate, 13, "-d")
	s.names[11], s.names[12], s.names[13] = ToolCaffeinate, ToolCaffeinate, ToolCaffeinate
	state, err := k.StopBlock(context.Background(), StopRequest{BlockId: "b1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.terminated) != 1 || s.terminated[0] != 11 {
		t.Fatalf("terminated %v, want only the bare caffeinate of b1", s.terminated)
	}
	ids := map[int32]bool{}
	for _, a := range state.Attempts {
		ids[a.Pid] = true
	}
	if ids[11] || !ids[12] || !ids[13] {
		t.Fatalf("attempts left: %+v", state.Attempts)
	}
}

func TestStopBlockLeavesAReusedPidAlone(t *testing.T) {
	s := makeStopEnv()
	s.policy = PolicyAllow
	k := s.keeper()
	shim(t, k, "b1", ToolCaffeinate, 11, "-i")
	s.names[11] = "zsh"
	state, err := k.StopBlock(context.Background(), StopRequest{BlockId: "b1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.terminated) != 0 {
		t.Fatalf("a pid running another program was terminated: %v", s.terminated)
	}
	if len(state.Attempts) != 0 {
		t.Fatalf("the ended attempt stays listed: %+v", state.Attempts)
	}
}

func TestStopBlockRefusesWhatItCannotStop(t *testing.T) {
	s := makeStopEnv()
	s.policy = PolicyLetSleep
	k := s.keeper()
	shim(t, k, "b1", ToolCaffeinate, 11, "-i")
	s.names[11] = ToolCaffeinate
	if _, err := k.StopBlock(context.Background(), StopRequest{BlockId: "b1"}); err == nil {
		t.Fatal("a neutralised attempt holds nothing and has nothing to stop")
	}
	if _, err := k.StopBlock(context.Background(), StopRequest{}); err == nil {
		t.Fatal("no terminal given")
	}
	s.policy = PolicyAllow
	shim(t, k, "b2", ToolCaffeinate, 21, "-i")
	s.names[21] = ToolCaffeinate
	s.failPid = 21
	state, err := k.StopBlock(context.Background(), StopRequest{BlockId: "b2"})
	if err == nil {
		t.Fatal("a failed termination is reported")
	}
	kept := false
	for _, a := range state.Attempts {
		kept = kept || a.Pid == 21
	}
	if !kept {
		t.Fatalf("an attempt whose process could not be ended is dropped: %+v", state.Attempts)
	}
}
