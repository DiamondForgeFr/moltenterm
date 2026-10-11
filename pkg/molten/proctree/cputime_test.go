// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

const burnEnv = "MOLTEN_PROCTREE_BURN"

// burn keeps one core busy for d of wall time.
func burn(d time.Duration) int {
	n := 0
	for end := time.Now().Add(d); time.Now().Before(end); {
		for i := 0; i < 10000; i++ {
			n += i % 7
		}
	}
	return n
}

// The child of TestReadCpu: it burns CPU, then exits and is reaped by the test.
func TestHelperBurn(t *testing.T) {
	if os.Getenv(burnEnv) == "" {
		t.Skip("helper process")
	}
	burn(300 * time.Millisecond)
}

func TestParseStatCpu(t *testing.T) {
	line := []byte("4242 (my (odd) name) S 4000 4242 4000 34816 4242 4194304 1 0 0 0 150 50 300 25 20 0 1 0 1500 1000 100\n")
	cpu, ok := parseStatCpu(line)
	if !ok {
		t.Fatal("not parsed")
	}
	if cpu.Self != 2*time.Second || cpu.Children != 3250*time.Millisecond {
		t.Errorf("parsed %+v, want 2s own and 3.25s of children", cpu)
	}
	if _, ok := parseStatCpu([]byte("7 (x) Z 1 7")); ok {
		t.Error("a short line parsed")
	}
}

func TestReadCpu(t *testing.T) {
	self := int32(os.Getpid())
	before, ok := ReadCpu(self)
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if ok {
			t.Error("unsupported platform read")
		}
		return
	}
	if !ok {
		t.Fatal("this process's CPU not read")
	}
	if _, ok := ReadCpu(0); ok {
		t.Error("pid 0 read")
	}
	burn(200 * time.Millisecond)
	afterBurn, _ := ReadCpu(self)
	own := afterBurn.Self - before.Self
	// The busy loop's 200 ms, give or take the scheduler and the runtime's own threads; a wrong time unit (Mach ticks
	// read as nanoseconds) is off by a factor of 40.
	if own < 100*time.Millisecond || own > 2*time.Second {
		t.Errorf("own CPU grew by %v over a 200 ms busy loop", own)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperBurn$")
	cmd.Env = append(os.Environ(), burnEnv+"=1")
	if err := cmd.Run(); err != nil {
		t.Fatalf("helper: %v", err)
	}
	child := cmd.ProcessState.UserTime() + cmd.ProcessState.SystemTime()
	afterChild, _ := ReadCpu(self)
	reaped := afterChild.Children - afterBurn.Children
	if child < 100*time.Millisecond {
		t.Fatalf("the helper used only %v", child)
	}
	t.Logf("own %v over a 200 ms busy loop; helper used %v, reaped %v", own, child, reaped)
	if reaped < child/2 || reaped > child*2 {
		t.Errorf("the reaped child's CPU grew by %v, the child used %v", reaped, child)
	}
}

// The cost of one CPU read, per process of a sampled tree.
func BenchmarkReadCpu(b *testing.B) {
	self := int32(os.Getpid())
	for i := 0; i < b.N; i++ {
		if _, ok := ReadCpu(self); !ok {
			b.Skip("unsupported")
		}
	}
}
