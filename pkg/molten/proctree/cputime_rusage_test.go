// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin || linux

package proctree

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

const (
	burnEnv = "MOLTEN_PROCTREE_BURN"
	// CPU time, not wall time: on a loaded machine a fixed wall-clock busy loop gets an unknown share of a core (#621).
	burnCpuTime = 200 * time.Millisecond
	// A starved process still gets its 200 ms of CPU well within this.
	burnDeadline = 2 * time.Minute
)

// burnSink keeps the busy loop from being optimised away.
var burnSink int

// rusageSelf is the kernel's own account of this process's CPU, the reference ReadCpu is checked against.
func rusageSelf() time.Duration {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

// burnCpu keeps a core busy until this process used want of CPU time, however long the scheduler makes that take.
func burnCpu(want time.Duration) bool {
	start := rusageSelf()
	deadline := time.Now().Add(burnDeadline)
	for rusageSelf()-start < want {
		if time.Now().After(deadline) {
			return false
		}
		for i := 0; i < 100000; i++ {
			burnSink += i % 7
		}
	}
	return true
}

// The child of TestReadCpu: it burns CPU, then exits and is reaped by the test.
func TestHelperBurn(t *testing.T) {
	if os.Getenv(burnEnv) == "" {
		t.Skip("helper process")
	}
	if !burnCpu(burnCpuTime) {
		t.Fatal("no CPU time given")
	}
}

func within(got time.Duration, want time.Duration) bool {
	return got >= want/2 && got <= want*2
}

func TestReadCpu(t *testing.T) {
	self := int32(os.Getpid())
	if _, ok := ReadCpu(0); ok {
		t.Error("pid 0 read")
	}
	refBefore := rusageSelf()
	before, ok := ReadCpu(self)
	if !ok {
		t.Fatal("this process's CPU not read")
	}
	if !burnCpu(burnCpuTime) {
		t.Fatalf("this process got less than %v of CPU in %v", burnCpuTime, burnDeadline)
	}
	afterBurn, _ := ReadCpu(self)
	ref := rusageSelf() - refBefore
	own := afterBurn.Self - before.Self
	// Within a factor of 2 of getrusage over the same window: a wrong time unit (Mach ticks read as nanoseconds) is
	// off by a factor of 40.
	if !within(own, ref) {
		t.Errorf("own CPU grew by %v, getrusage counted %v", own, ref)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperBurn$")
	cmd.Env = append(os.Environ(), burnEnv+"=1")
	beforeChild, _ := ReadCpu(self)
	if err := cmd.Run(); err != nil {
		t.Fatalf("helper: %v", err)
	}
	child := cmd.ProcessState.UserTime() + cmd.ProcessState.SystemTime()
	afterChild, _ := ReadCpu(self)
	reaped := afterChild.Children - beforeChild.Children
	if child < burnCpuTime {
		t.Fatalf("the helper used only %v", child)
	}
	t.Logf("own %v (getrusage %v); helper used %v, reaped %v", own, ref, child, reaped)
	if !within(reaped, child) {
		t.Errorf("the reaped child's CPU grew by %v, the child used %v", reaped, child)
	}
}
